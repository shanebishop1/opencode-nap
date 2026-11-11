import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

interface Step { expect?: string; send?: string; sleep?: number }
interface FakeResult { argv: string[]; stdin: string; markKept: boolean }
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
  input: { card?: string; wakeOnFocus?: boolean; opencodePath?: string; args?: string[] },
  steps: Step[],
  timeoutMs = 6_000,
): Promise<Run> {
  const exec = buildStubExec({
    card: input.card ?? CARD,
    wakeOnFocus: input.wakeOnFocus ?? false,
    opencodePath: input.opencodePath ?? opencode,
    args: input.args ?? [],
  })
  const pty = await startPty({
    command: [exec.file, ...exec.argv.slice(1)],
    env: { ...process.env, NAP_TEST_MARK: MARK } as Record<string, string>,
    cwd: dir,
    outputFile: join(dir, `run-${++runs}.out`),
  })
  const deadline = Date.now() + timeoutMs
  let status: number | null = null
  try {
    let seen = 0
    for (const step of steps) {
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
      "sh", "-c", STUB_SCRIPT, "sh", "My session", "focus", "/opt/opencode", "-s", "ses_1", "$(touch x)",
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
