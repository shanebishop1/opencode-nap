import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STUB_SCRIPT, buildStubExec } from "../src/stub.js"
import { startPty } from "./e2e/pty.js"

const FAKE = join(import.meta.dir, "fixtures", "fake-opencode.py")
const CARD = "NAP CARD"
const ESC = "\x1b"
// The stub turns click reporting on last, just before it waits for input.
const ARMED = `${ESC}[?1000h${ESC}[?1006h`
const SPACE = " "
const CLICK_PRESS = `${ESC}[<0;10;5M`
const CLICK_RELEASE = `${ESC}[<0;10;5m`
const PROBE = "Z"
const MARK = "nap-test-mark"

const TRICKY_ARGS = [
  "--server",
  "http://127.0.0.1:4096",
  "-s",
  "ses_123",
  "two words",
  "it's \"quoted\"",
  "$HOME and `cmd`",
  "line one\nline two",
  "--dash-led",
  "-",
  "",
  "trailing newline\n",
]

const RESET_SEQUENCES = [
  "?2026l", "?1049l", "<99u", "?1000l", "?1002l", "?1003l", "?1006l",
  "?1015l", "?1004l", "?2004l", "?2027l", "?2031l", "?25h", "0m", "2J", "H",
].map(seq => `${ESC}[${seq}`)

// The command the stub prints when it cannot wake: plain words bare, the rest single-quoted.
const resumeCommand = (opencodePath: string, args: string[]): string =>
  [opencodePath, ...args].map(word => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(" ")

interface Step { expect?: string; send?: string; sleep?: number; run?: () => void }
interface FakeResult { argv: string[]; stdin: string; markKept: boolean; password: string | null; napServer: string | null }
interface Run { output: string; status: number | null; timedOut: boolean; fake?: FakeResult }

// Above a run's own 6 s limit, so a hung stub is killed and reported.
setDefaultTimeout(15_000)

let dir: string
let opencode: string
let runs = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-nap-stub-"))
  opencode = join(dir, "opencode")
  const python = Bun.which("python3")
  if (!python) throw new Error("python3 is required for the stub tests")
  writeFileSync(opencode, `#!/bin/sh\nexec '${python}' -I '${FAKE}' "$@"\n`)
  chmodSync(opencode, 0o755)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

/**
 * Runs the stub under a terminal. Steps run in order: `expect` waits for text
 * in the output after the last match, `send` types, `sleep` waits. A run that
 * has not exited within `timeoutMs` is stopped and reported as timed out.
 */
async function runStub(
  input: {
    card?: string
    terminalTitle?: string
    wakeOnFocus?: boolean
    opencodePath?: string
    service?: { file: string; version: string }
    env?: Record<string, string>
    args?: string[]
  },
  steps: Step[],
  timeoutMs = 6_000,
): Promise<Run> {
  const exec = buildStubExec({
    card: input.card ?? CARD,
    terminalTitle: input.terminalTitle,
    wakeOnFocus: input.wakeOnFocus ?? false,
    opencodePath: input.opencodePath ?? opencode,
    service: input.service,
    args: input.args ?? [],
  })
  const pty = await startPty({
    command: [exec.file, ...exec.argv.slice(1)],
    env: { ...process.env, NAP_TEST_MARK: MARK, ...input.env } as Record<string, string>,
    cwd: dir,
    outputFile: join(dir, `run-${++runs}.out`),
  })
  const deadline = Date.now() + timeoutMs
  let status: number | null = null
  try {
    let seen = 0
    for (const step of steps) {
      step.run?.()
      if (step.send !== undefined) pty.write(step.send)
      if (step.sleep !== undefined) await sleep(step.sleep)
      if (step.expect === undefined) continue
      while (pty.output().indexOf(step.expect, seen) < 0 && Date.now() < deadline) await sleep(5)
      const at = pty.output().indexOf(step.expect, seen)
      if (at < 0) break
      seen = at + step.expect.length
    }
    status = await Promise.race([pty.exited, sleep(Math.max(0, deadline - Date.now())).then(() => null)])
  } finally {
    await pty.stop()
  }
  const output = pty.output()
  const match = /@@RESULT@@(.*)@@END@@/s.exec(output)
  const fake = match ? JSON.parse(match[1]) as FakeResult : undefined
  return { output, status, timedOut: status === null, fake }
}

function wakeSteps(wake: Step[]): Step[] {
  return [{ expect: ARMED }, ...wake, { expect: "@@READY@@" }, { send: PROBE }]
}

// The card's part of the output: everything before the target takes over.
function napOutput(run: Run): string {
  const end = run.output.indexOf("@@READY@@")
  return end < 0 ? run.output : run.output.slice(0, end)
}

describe("buildStubExec", () => {
  it("passes every value as a positional argument after the script", () => {
    const exec = buildStubExec({
      card: "My session",
      wakeOnFocus: true,
      opencodePath: "/opt/opencode",
      args: ["-s", "ses_1", "$(touch x)"],
    })

    expect(exec.file).toBe("/bin/sh")
    expect(exec.argv).toEqual([
      "sh", "-c", STUB_SCRIPT, "sh", "My session", "focus", "/opt/opencode", "", "", "-s", "ses_1", "$(touch x)",
    ])
    expect(STUB_SCRIPT).not.toContain("My session")
  })

})

describe("resumeCommand", () => {
  it("leaves plain words bare and single-quotes the rest", () => {
    expect(resumeCommand("/usr/bin/opencode", ["-s", "ses_1", "--log-level=DEBUG"]))
      .toBe("/usr/bin/opencode -s ses_1 --log-level=DEBUG")
    expect(resumeCommand("/a b/opencode", ["it's", "", "$X", "a\nb", "~"]))
      .toBe("'/a b/opencode' 'it'\\''s' '' '$X' 'a\nb' '~'")
  })

  it("round-trips through sh", async () => {
    const command = resumeCommand("printf", ["[%s]", ...TRICKY_ARGS])
    const out = await Bun.spawn(["sh", "-c", command], { stdout: "pipe" }).stdout
    expect(await new Response(out).text()).toBe(TRICKY_ARGS.map(arg => `[${arg}]`).join(""))
  })
})

describe("stub under a terminal", () => {
  it("ac-terminal-clean: resets terminal modes, shows the card, then enables clicks only", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    const nap = napOutput(run)
    const card = nap.indexOf(CARD)

    expect(run.timedOut).toBe(false)
    expect(card).toBeGreaterThan(0)
    for (const seq of RESET_SEQUENCES) {
      expect(nap.indexOf(seq)).toBeGreaterThanOrEqual(0)
      expect(nap.indexOf(seq)).toBeLessThan(card)
    }
    expect(nap.indexOf(`${ESC}[<99u`)).toBeLessThan(nap.indexOf(`${ESC}[?1049l`))
    expect(nap.lastIndexOf(`${ESC}[<99u`)).toBeGreaterThan(nap.indexOf(`${ESC}[?1049l`))
    expect(nap.indexOf(ARMED)).toBeGreaterThan(card)
    expect(nap.lastIndexOf(`${ESC}[?1000l${ESC}[?1006l`)).toBeGreaterThan(card)
    for (const mode of ["1002", "1003", "1004", "1015", "1049", "2004"]) {
      expect(nap).not.toContain(`${ESC}[?${mode}h`)
    }
  })

  it("ac-terminal-clean: prints the card verbatim, with nothing in it interpreted", async () => {
    const card = `${ESC}[1m100%s \\n \\033 $HOME $(x) \`y\`${ESC}[0m`
    const run = await runStub({ card }, wakeSteps([{ send: SPACE }]))
    expect(napOutput(run)).toContain(`${ESC}[H${card}${ESC}[?1000h`)
  })

  it("replays the title as text after the screen reset and before the card", async () => {
    const terminalTitle = "  100% café $HOME\x00\x07\x1b\\\x9c\x7f\n"
    const run = await runStub({ terminalTitle }, wakeSteps([{ send: SPACE }]))
    expect(run.timedOut).toBe(false)
    expect(napOutput(run)).toContain(`${ESC}[H${ESC}]0;  100% café $HOME   \\   \x07${CARD}${ARMED}`)
  })

  it("ac-terminal-clean: clears the card's colours and screen before OpenCode starts", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    const woken = run.output.slice(run.output.indexOf(ARMED))
    expect(woken).toContain(`${ESC}[?1000l${ESC}[?1006l`)
    expect(woken.indexOf(`${ESC}[0m${ESC}[?25h${ESC}[2J${ESC}[H`)).toBeGreaterThan(woken.indexOf(`${ESC}[?1000l`))
    expect(woken.indexOf(`${ESC}[0m${ESC}[?25h${ESC}[2J${ESC}[H`)).toBeLessThan(woken.indexOf("@@READY@@"))
  })

  it("ac-wake-key: a key wakes OpenCode with exactly its arguments and environment", async () => {
    const run = await runStub({ args: TRICKY_ARGS }, wakeSteps([{ send: SPACE }]))

    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(0)
    expect(run.fake?.argv).toEqual(TRICKY_ARGS)
    expect(run.fake?.markKept).toBe(true)
  })

  it("ac-focus-wake: with focus waking, focus in wakes it and reporting is off again for OpenCode", async () => {
    const run = await runStub({ wakeOnFocus: true }, wakeSteps([{ send: `${ESC}[O` }, { sleep: 300 }, { send: `${ESC}[I` }]))
    const nap = napOutput(run)
    expect(nap.lastIndexOf(`${ESC}[?1004l`)).toBeGreaterThan(nap.indexOf(`${ESC}[?1004h`))
    expect(run.status).toBe(0)
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-focus-wake: focus out alone leaves it napping", async () => {
    const run = await runStub({ wakeOnFocus: true }, [{ expect: ARMED }, { send: `${ESC}[O` }, { expect: "@@READY@@" }], 1_500)
    expect(run.timedOut).toBe(true)
    expect(run.output).not.toContain("@@READY@@")
  })

  it("ac-focus-no-wake: without focus waking, focus reporting stays off", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    expect(napOutput(run)).not.toContain(`${ESC}[?1004h`)
  })

  it("ac-wake-key: the wake key does not reach OpenCode", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-wake-key: Ctrl-C wakes the stub instead of stopping it", async () => {
    const run = await runStub({}, wakeSteps([{ send: "\x03" }]))

    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(0)
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-wake-key: the rest of a multi-byte key is swallowed too", async () => {
    const run = await runStub({}, wakeSteps([{ send: `${ESC}[A` }]))
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-wake-click: a click wakes OpenCode and no part of the mouse sequence reaches it", async () => {
    const run = await runStub(
      { args: ["-s", "ses_click"] },
      wakeSteps([{ send: CLICK_PRESS }, { sleep: 30 }, { send: CLICK_RELEASE }]),
    )

    expect(run.timedOut).toBe(false)
    expect(run.fake?.argv).toEqual(["-s", "ses_click"])
    expect(run.fake?.stdin).toBe(PROBE)
    expect(run.output).not.toContain("[<0;10;5")
  })

  it("ac-wake-click: a press and release arriving together are swallowed", async () => {
    const run = await runStub({}, wakeSteps([{ send: CLICK_PRESS + CLICK_RELEASE }]))
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("input queued at nap time is discarded and does not wake the stub", async () => {
    const stale = `${ESC}[O${ESC}]11;rgb:0000/0000/0000${ESC}\\`
    const run = await runStub({}, [{ send: stale }, { expect: ARMED }, { sleep: 500 }], 1_500)

    expect(run.timedOut).toBe(true)
    expect(run.output).not.toContain("@@READY@@")
    expect(run.output.slice(run.output.indexOf(ARMED))).not.toContain(`${ESC}[?1000l`)
  })

  it("ac-binary-missing: prints the resume command and exits non-zero with modes reset", async () => {
    const missing = join(dir, "gone", "opencode")
    const args = ["-s", "ses_9", "it's here", "$PATH"]
    const run = await runStub({ opencodePath: missing, args }, [{ expect: ARMED }, { send: SPACE }])
    const after = run.output.slice(run.output.indexOf(CARD))

    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(1)
    expect(run.fake).toBeUndefined()
    expect(after).toContain(`Cannot wake: ${missing} is not executable.`)
    expect(after).toContain(`  ${resumeCommand(missing, args)}\r\n`)
    expect(after.indexOf(`${ESC}[?1000l${ESC}[?1006l`)).toBeLessThan(after.indexOf("Cannot wake"))
  })

  it("ac-binary-missing: a directory or a file without the execute bit counts as missing", async () => {
    const plain = join(dir, "not-executable")
    writeFileSync(plain, "#!/bin/sh\n")
    chmodSync(plain, 0o644)

    for (const path of [dir, plain]) {
      const run = await runStub({ opencodePath: path }, [{ expect: ARMED }, { send: SPACE }])
      expect(run.status).toBe(1)
      expect(run.output).toContain(`To resume, run:\r\n  ${resumeCommand(path, [])}\r\n`)
    }
  })
})

describe("waking into the background service", () => {
  const VERSION = "9.9.9-test"
  const ARGS = ["-s", "ses_svc"]
  let password: string
  let bin: string
  let curlLog: string
  let live: ReturnType<typeof Bun.spawn>
  let files = 0

  beforeAll(() => {
    password = `pw-${crypto.randomUUID()}`
    bin = join(dir, "bin")
    curlLog = join(dir, "curl-argv.log")
    const curl = Bun.which("curl")
    if (!curl) throw new Error("curl is required for the service wake tests")
    mkdirSync(bin, { recursive: true })
    // Records curl's arguments, so a test can show the password is not among them.
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >> '${curlLog}'\nexec '${curl}' "$@"\n`)
    chmodSync(join(bin, "curl"), 0o755)
    live = Bun.spawn(["sleep", "300"])
  })

  afterAll(() => {
    live.kill("SIGKILL")
  })

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** A stand-in service whose nth /api/info answer waits answers[n].delay ms and has answers[n].status. */
  function fakeService(answers: Array<{ delay?: number; status?: number }> = []) {
    const requests: number[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const { delay = 0, status = 200 } = answers[requests.push(Date.now()) - 1] ?? {}
        if (delay) await Bun.sleep(delay)
        if (request.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`) return new Response("", { status: 401 })
        if (status !== 200) return new Response("", { status })
        return Response.json({ version: VERSION, pid: live.pid })
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
  }

  function register(entry: Record<string, unknown>): string {
    const file = join(dir, `service-${++files}.json`)
    writeFileSync(file, JSON.stringify(entry))
    return file
  }

  const entry = (url: string, overrides: Record<string, unknown> = {}) =>
    ({ id: "svc", version: VERSION, url, pid: live.pid, password, ...overrides })

  // Each run gets more room than the terminal tests: it also starts curl and a server request.
  const RUN_MS = 12_000
  const WAITING = "Waiting for the OpenCode service at"
  const TEST_MS = 30_000

  const wakeInto = (file: string, extra: { env?: Record<string, string>; version?: string } = {}, timeoutMs = RUN_MS) =>
    runStub(
      { args: ARGS, service: { file, version: extra.version ?? VERSION }, env: { PATH: `${bin}:${process.env.PATH}`, ...extra.env } },
      wakeSteps([{ send: SPACE }]),
      timeoutMs,
    )

  const curlArgs = (): string => {
    try {
      return readFileSync(curlLog, "utf8")
    } catch {
      return ""
    }
  }

  it("ac-service-attach: a running service gets --server, with its password only in the environment", async () => {
    const service = fakeService()
    try {
      const run = await wakeInto(register(entry(service.url)))
      expect(run.status).toBe(0)
      expect(run.fake?.argv).toEqual(["--server", service.url, ...ARGS])
      expect(run.fake?.password).toBe(password)
      expect(run.fake?.napServer).toBe(service.url)
      expect(run.fake?.argv.join("\n")).not.toContain(password)
      expect(service.requests).toHaveLength(1)
      expect(curlArgs()).toContain(`${service.url}/api/info`)
      expect(curlArgs()).not.toContain(password)
    } finally {
      service.stop()
    }
  }, TEST_MS)

  it("ac-service-attach: without curl it still wakes with --server, unchecked", async () => {
    const tools = join(dir, "tools")
    mkdirSync(tools, { recursive: true })
    for (const tool of ["stty", "dd"]) {
      const path = Bun.which(tool)
      if (!path) throw new Error(`${tool} is required`)
      if (!Bun.which(tool, { PATH: tools })) symlinkSync(path, join(tools, tool))
    }
    const service = fakeService()
    try {
      const run = await wakeInto(register(entry(service.url)), { env: { PATH: tools } })
      expect(run.fake?.argv).toEqual(["--server", service.url, ...ARGS])
      expect(service.requests).toHaveLength(0)
    } finally {
      service.stop()
    }
  }, TEST_MS)

  it("ac-service-busy: a service that is still starting (HTTP 503) is waited for, then attached to", async () => {
    const service = fakeService([{ status: 503 }])
    try {
      const run = await wakeInto(register(entry(service.url)))
      expect(run.output).toContain(WAITING)
      expect(run.fake?.argv).toEqual(["--server", service.url, ...ARGS])
      expect(service.requests).toHaveLength(2)
    } finally {
      service.stop()
    }
  }, TEST_MS)

  it("ac-service-busy: a wake against a slow service waits for it and never falls back to the plain start", async () => {
    // The first answer comes after curl's 4 s limit, the second in time.
    const service = fakeService([{ delay: 5_000 }, { delay: 1_500 }])
    try {
      const run = await wakeInto(register(entry(service.url)), {}, 25_000)
      expect(run.timedOut).toBe(false)
      expect(run.output).toContain(`Waiting for the OpenCode service at ${service.url} to answer.`)
      expect(run.output.split("@@READY@@")).toHaveLength(2)
      expect(run.fake?.argv).toEqual(["--server", service.url, ...ARGS])
      expect(service.requests).toHaveLength(2)
      expect(alive(live.pid)).toBe(true)
    } finally {
      service.stop()
    }
  }, 40_000)

  describe("ac-service-fallback: anything but a running, matching service gets the plain start", () => {
    const expectPlain = (run: Run) => {
      expect(run.status).toBe(0)
      expect(run.fake?.argv).toEqual(ARGS)
      expect(run.fake?.password).toBeNull()
      expect(run.fake?.napServer).toBeNull()
    }

    it("a missing registration", async () => {
      expectPlain(await wakeInto(join(dir, "no-such-service.json")))
    }, TEST_MS)

    it("no registration given, as for a window that names its own server", async () => {
      expectPlain(await runStub({ args: ARGS }, wakeSteps([{ send: SPACE }]), RUN_MS))
    }, TEST_MS)

    it("a registration whose pid is gone", async () => {
      const gone = Bun.spawn(["true"])
      await gone.exited
      const service = fakeService()
      try {
        expectPlain(await wakeInto(register(entry(service.url, { pid: gone.pid }))))
        expect(service.requests).toHaveLength(0)
      } finally {
        service.stop()
      }
    }, TEST_MS)

    it("a service of another version", async () => {
      const service = fakeService()
      try {
        expectPlain(await wakeInto(register(entry(service.url)), { version: "1.0.0" }))
      } finally {
        service.stop()
      }
    }, TEST_MS)

    it("a service that rejects the password", async () => {
      const service = fakeService()
      try {
        expectPlain(await wakeInto(register(entry(service.url, { password: "wrong" }))))
        expect(service.requests).toHaveLength(1)
      } finally {
        service.stop()
      }
    }, TEST_MS)

    it("nothing listening at the registered URL", async () => {
      const service = fakeService()
      service.stop()
      expectPlain(await wakeInto(register(entry(service.url))))
    }, TEST_MS)

    const unreadable: Array<[string, Record<string, unknown>]> = [
      ["an escaped password", { password: 'has"quote' }],
      // The live pid itself, so only the quoting can refuse it.
      ["a pid written as a string", { pid: "LIVE" }],
      ["pid 0, which kill -0 would take for the stub's own group", { pid: 0 }],
      ["a URL that is not HTTP", { url: "file:///etc/passwd" }],
    ]
    for (const [name, bad] of unreadable) {
      it(`values it cannot read safely: ${name}`, async () => {
        const service = fakeService()
        try {
          expectPlain(await wakeInto(register(entry(service.url, bad.pid === "LIVE" ? { pid: String(live.pid) } : bad))))
          expect(service.requests).toHaveLength(0)
        } finally {
          service.stop()
        }
      }, TEST_MS)
    }

    it("a registration it cannot read", async () => {
      const service = fakeService()
      try {
        const file = register(entry(service.url))
        chmodSync(file, 0o000)
        expectPlain(await wakeInto(file))
        expect(service.requests).toHaveLength(0)
      } finally {
        service.stop()
      }
    }, TEST_MS)

    it("a service that has failed (HTTP 500)", async () => {
      const service = fakeService([{ status: 500 }])
      try {
        expectPlain(await wakeInto(register(entry(service.url))))
        expect(service.requests).toHaveLength(1)
      } finally {
        service.stop()
      }
    }, TEST_MS)

    it("a service whose process ends while the wake waits for it", async () => {
      const doomed = Bun.spawn(["sleep", "300"])
      const service = fakeService([{ delay: 60_000 }, { delay: 60_000 }])
      try {
        const file = register(entry(service.url, { pid: doomed.pid }))
        expectPlain(await runStub(
          { args: ARGS, service: { file, version: VERSION }, env: { PATH: `${bin}:${process.env.PATH}` } },
          [{ expect: ARMED }, { send: SPACE }, { expect: WAITING }, { run: () => doomed.kill("SIGKILL") }, { expect: "@@READY@@" }, { send: PROBE }],
          25_000,
        ))
      } finally {
        doomed.kill("SIGKILL")
        service.stop()
      }
    }, 40_000)

    it("Ctrl-C while it waits for a service that never answers", async () => {
      const service = fakeService([{ delay: 60_000 }, { delay: 60_000 }])
      try {
        const file = register(entry(service.url))
        const run = await runStub(
          { args: ARGS, service: { file, version: VERSION }, env: { PATH: `${bin}:${process.env.PATH}` } },
          [{ expect: ARMED }, { send: SPACE }, { expect: WAITING }, { send: "\x03" }, { expect: "@@READY@@" }, { send: PROBE }],
          20_000,
        )
        expect(run.output).toContain("Ctrl-C stops waiting and starts OpenCode the usual way")
        expectPlain(run)
        expect(alive(live.pid)).toBe(true)
      } finally {
        service.stop()
      }
    }, 40_000)

    it("a registration that is not JSON", async () => {
      const file = join(dir, "not-json.json")
      writeFileSync(file, "garbage")
      expectPlain(await wakeInto(file))
    }, TEST_MS)
  })
})
