import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STUB_SCRIPT,
  buildStubExec,
  resumeCommand,
  sanitizeTitle,
} from "../src/stub.js"

const HELPER = join(import.meta.dir, "fixtures", "pty-run.py")
const FAKE = join(import.meta.dir, "fixtures", "fake-opencode.py")
const CARD = "Press any key or click to wake."
const ESC = "\x1b"
// The stub turns click reporting on last, just before it waits for input.
const ARMED = `${ESC}[?1000h${ESC}[?1006h`
const SPACE = "20"
const CLICK_PRESS = Buffer.from(`${ESC}[<0;10;5M`).toString("hex")
const CLICK_RELEASE = Buffer.from(`${ESC}[<0;10;5m`).toString("hex")
const PROBE = Buffer.from("Z").toString("hex")
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

interface Step { expect?: string; send?: string; sleep?: number }
interface FakeResult { argv: string[]; stdin: string; mark: string | null }
interface Run { output: string; status: number | null; timedOut: boolean; fake?: FakeResult }

// Above the helper's own 6 s timeout, so a hung stub is killed and reported.
setDefaultTimeout(15_000)

let dir: string
let opencode: string

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

async function runStub(
  input: { cardTitle?: string; opencodePath?: string; args?: string[] },
  steps: Step[],
  timeout = 6,
): Promise<Run> {
  const exec = buildStubExec({
    cardTitle: input.cardTitle,
    opencodePath: input.opencodePath ?? opencode,
    args: input.args ?? [],
  })
  const spec = { file: exec.file, argv: exec.argv, steps, timeout }
  const proc = Bun.spawn(["python3", "-I", HELPER, JSON.stringify(spec)], {
    env: { ...process.env, NAP_TEST_MARK: MARK },
    stdout: "pipe",
    stderr: "inherit",
  })
  const guard = setTimeout(() => proc.kill(), 10_000)
  try {
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const raw = JSON.parse(text) as { output: string; status: number | null; timedOut: boolean }
    const output = Buffer.from(raw.output, "hex").toString("latin1")
    const match = /@@RESULT@@(.*)@@END@@/s.exec(output)
    const fake = match ? JSON.parse(Buffer.from(match[1], "latin1").toString("utf8")) as FakeResult : undefined
    return { output, status: raw.status, timedOut: raw.timedOut, fake }
  } finally {
    clearTimeout(guard)
    proc.kill()
  }
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
      cardTitle: "My session",
      opencodePath: "/opt/opencode",
      args: ["-s", "ses_1", "$(touch x)"],
    })

    expect(exec.file).toBe("/bin/sh")
    expect(exec.argv).toEqual([
      "sh", "-c", STUB_SCRIPT, "sh", "My session", "/opt/opencode", "-s", "ses_1", "$(touch x)",
    ])
    expect(STUB_SCRIPT).not.toContain("My session")
  })

  it("passes an empty title when the session title is unknown", () => {
    expect(buildStubExec({ cardTitle: undefined, opencodePath: "/o", args: [] }).argv[4]).toBe("")
  })
})

describe("sanitizeTitle", () => {
  it("replaces control characters, ESC and C1 with spaces", () => {
    expect(sanitizeTitle(`a${ESC}[31mred\x07\x00\tb\nc\x9bd\x7f`)).toBe("a [31mred b c d")
    expect(sanitizeTitle(`${ESC}]0;x\x07`)).toBe("]0;x")
    expect(sanitizeTitle("plain title")).toBe("plain title")
    expect(sanitizeTitle(undefined)).toBe("")
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
    const run = await runStub({ cardTitle: `Fix ${ESC}[2J the bug\x07` }, wakeSteps([{ send: SPACE }]))
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
    expect(nap).toContain("Fix [2J the bug\r\n")
    expect(nap).not.toContain(`${ESC}[2J the bug`)
    expect(nap.indexOf(ARMED)).toBeGreaterThan(card)
    expect(nap.lastIndexOf(`${ESC}[?1000l${ESC}[?1006l`)).toBeGreaterThan(card)
    for (const mode of ["1002", "1003", "1004", "1015", "1049", "2004"]) {
      expect(nap).not.toContain(`${ESC}[?${mode}h`)
    }
  })

  it("ac-terminal-clean: omits the title line when there is no title", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    expect(napOutput(run)).toContain(`${ESC}[HNapping to save memory. ${CARD}`)
  })

  it("ac-wake-key: a key wakes OpenCode with exactly its arguments and environment", async () => {
    const run = await runStub({ cardTitle: "Session", args: TRICKY_ARGS }, wakeSteps([{ send: SPACE }]))

    expect(run.timedOut).toBe(false)
    expect(run.status).toBe(0)
    expect(run.fake?.argv).toEqual(TRICKY_ARGS)
    expect(run.fake?.mark).toBe(MARK)
  })

  it("ac-wake-key: the wake key does not reach OpenCode", async () => {
    const run = await runStub({}, wakeSteps([{ send: SPACE }]))
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-wake-key: the rest of a multi-byte key is swallowed too", async () => {
    const arrowUp = Buffer.from(`${ESC}[A`).toString("hex")
    const run = await runStub({}, wakeSteps([{ send: arrowUp }]))
    expect(run.fake?.stdin).toBe(PROBE)
  })

  it("ac-wake-click: a click wakes OpenCode and no part of the mouse sequence reaches it", async () => {
    const run = await runStub(
      { args: ["-s", "ses_click"] },
      wakeSteps([{ send: CLICK_PRESS }, { sleep: 0.03 }, { send: CLICK_RELEASE }]),
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
    const stale = Buffer.from(`${ESC}[O${ESC}]11;rgb:0000/0000/0000${ESC}\\`).toString("hex")
    const run = await runStub({}, [{ send: stale }, { expect: ARMED }, { sleep: 0.5 }], 1.5)

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
