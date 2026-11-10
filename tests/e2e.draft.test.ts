import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { cp, mkdir, readFile, writeFile } from "fs/promises"
import { join, resolve } from "path"
import {
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  installedPackage,
  startServer,
  startTui,
  writeCliConfig,
  type Scratch,
} from "./e2e/harness.js"
import { stripEscapes, type PtyProcess } from "./e2e/pty.js"

const enabled = process.env.NAP_E2E === "1"

let scratch: Scratch | undefined
let server: { process: PtyProcess; url: string } | undefined
let probePackage = ""

const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))

type Entry = { message?: string; phase?: string; [key: string]: any }

const readEntries = async (file: string): Promise<Entry[]> => {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

// Bracketed paste puts several lines in the prompt without an Enter, so nothing is submitted.
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

/** One TUI with the plugin and the test-only prompt probe, napped and woken with Space. */
async function napAndWake(name: string, fill: (tui: PtyProcess, probe: Probe) => Promise<void>, options: Record<string, unknown> = {}) {
  if (!scratch || !server) throw new Error("setup failed")
  const debugLogFile = join(scratch.root, `${name}.nap.log`)
  const probeLog = join(scratch.root, `${name}.probe.log`)
  const ctl = join(scratch.root, `${name}.ctl`)
  await mkdir(ctl)
  await writeCliConfig(scratch, [
    { package: installedPackage(scratch), options: { idleMinutes: 0.25, debugLogFile, ...options } },
    { package: probePackage, options: { log: probeLog, ctl } },
  ])
  const sessionID = await createSession(scratch, server.url)
  const tui = await startTui(scratch, server.url, sessionID)
  // Every TUI appends to the same output file, so only this one's output counts.
  const start = tui.output().length
  const screen = () => stripEscapes(tui.output().slice(start))
  const context = async () =>
    `nap log:\n${JSON.stringify(await readEntries(debugLogFile)).slice(-3000)}\nTUI screen:\n${screen().slice(-2000)}`

  const waitForLog = async (count: number, message: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await readEntries(debugLogFile)).filter(entry => entry.message === message).length >= count) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for "${message}" #${count}\n${await context()}`)
  }

  const probe: Probe = {
    async report() {
      const before = (await readEntries(probeLog)).length
      await writeFile(join(ctl, "report"), "")
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const reports = (await readEntries(probeLog)).slice(before).filter(entry => entry.phase === "report")
        if (reports.length) return reports[0]
        await sleep(100)
      }
      throw new Error(`the prompt probe did not report\n${await context()}`)
    },
    async until(check, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let last: Entry = {}
      while (Date.now() < deadline) {
        last = await probe.report()
        if (check(last)) return last
        await sleep(200)
      }
      throw new Error(`the prompt never matched; last report ${JSON.stringify(last).slice(0, 500)}\n${await context()}`)
    },
    async set(text) {
      await writeFile(join(ctl, "set"), text)
    },
  }

  await waitForLog(1, "watching", 60_000)
  await probe.until(report => report.prompt === true, 30_000)
  await fill(tui, probe)
  const before = await probe.report()

  const deadline = Date.now() + 60_000
  while (!screen().includes("Napping to save memory. Press any key or click to wake.")) {
    if (Date.now() > deadline) throw new Error(`the nap card never showed\n${await context()}`)
    await sleep(100)
  }
  await sleep(500)
  const drafts = draftFiles(scratch)
  const whileNapped = drafts.map(file => ({ mode: statSync(file).mode & 0o777, sha256: sha256(readFileSync(file, "utf8")) }))

  tui.write(" ")
  await waitForLog(2, "watching", 60_000)
  return { tui, screen, before, whileNapped, probe, debugLogFile, context }
}

type Probe = {
  report(): Promise<Entry>
  until(check: (report: Entry) => boolean, timeoutMs: number): Promise<Entry>
  set(text: string): Promise<void>
}

/** Draft files in the TUI's per-user draft directory under its TMPDIR. */
function draftFiles(scratch: Scratch): string[] {
  const dir = join(scratch.env.TMPDIR, `opencode-nap-${process.getuid?.() ?? "user"}`)
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : []
}

describe.skipIf(!enabled)(`OpenCode ${cliVersion}: the unsent draft survives a nap`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
    probePackage = join(scratch.root, "prompt-probe")
    await cp(resolve(import.meta.dir, "e2e", "fixtures", "prompt-probe"), probePackage, { recursive: true })
  }, 300_000)

  afterAll(async () => {
    const survivors = await cleanup()
    if (survivors.length) throw new Error(`processes outlived the test and were killed:\n${survivors.join("\n")}`)
  }, 60_000)

  it("ac-draft-restored, ac-draft-file, ac-draft-not-logged: a typed multi-line, non-ASCII draft comes back with the cursor at the end", async () => {
    const typed = "hello wörld ☃ 日本語 "
    const pasted = "second line\nthird — “line” ✓"
    const draft = typed + pasted
    const { tui, screen, before, whileNapped, probe, debugLogFile, context } = await napAndWake("restored", async tui => {
      for (const character of typed) {
        tui.write(character)
        await sleep(20)
      }
      tui.write(paste(pasted))
      await sleep(500)
    })
    expect(before.text, await context()).toBe(draft)
    expect(whileNapped, await context()).toEqual([{ mode: 0o600, sha256: sha256(draft) }])

    const after = await probe.until(report => report.text === draft, 30_000)
    expect(after.cursorOffset, await context()).toBe(before.cursorOffset)
    expect(after.logicalCursor, await context()).toEqual(before.logicalCursor)
    expect(screen().slice(screen().lastIndexOf("Napping to save memory")), await context()).toContain("third")
    expect(draftFiles(scratch!), await context()).toEqual([])

    const log = await readFile(debugLogFile, "utf8")
    expect(log).toContain('"draft restored"')
    for (const part of ["wörld", "日本語", "second line", "third", "“line”"]) expect(log).not.toContain(part)
    await tui.stop()
  }, 240_000)

  it("ac-draft-empty: an empty prompt naps without a draft file and wakes empty", async () => {
    const { tui, before, whileNapped, probe, debugLogFile, context } = await napAndWake("empty", async () => {})
    expect(before.text, await context()).toBe("")
    expect(whileNapped, await context()).toEqual([])
    // The prompt is back and stays empty.
    await probe.until(report => report.prompt === true, 30_000)
    await sleep(1_000)
    expect((await probe.report()).text, await context()).toBe("")
    expect((await readEntries(debugLogFile)).map(entry => entry.message), await context()).not.toContain("draft restored")
    await tui.stop()
  }, 240_000)

  it("ac-draft-off: with carryDraft false the typed text is not carried, so the restore above is the plugin's", async () => {
    const { tui, before, whileNapped, probe, context } = await napAndWake("off", async tui => {
      tui.write("not carried")
      await sleep(500)
    }, { carryDraft: false })
    expect(before.text, await context()).toBe("not carried")
    expect(whileNapped, await context()).toEqual([])
    await probe.until(report => report.prompt === true, 30_000)
    await sleep(1_000)
    expect((await probe.report()).text, await context()).toBe("")
    await tui.stop()
  }, 240_000)

  it("ac-draft-large: a 1 MB draft comes back intact", async () => {
    // Set through the test probe: OpenCode turns a large paste into a placeholder
    // rather than prompt text, and typing 1 MB through a terminal is too slow.
    const large = "A large draft line with ✓ and ü in it.\n".repeat(27_000).slice(0, 1024 * 1024)
    const { tui, before, whileNapped, probe, context } = await napAndWake("large", async (_, probe) => {
      await probe.set(large)
      await probe.until(report => report.length === large.length, 30_000)
    })
    expect(before.sha256, await context()).toBe(sha256(large))
    expect(whileNapped, await context()).toEqual([{ mode: 0o600, sha256: sha256(large) }])
    const after = await probe.until(report => report.sha256 === sha256(large), 60_000)
    expect(after.cursorOffset, await context()).toBe(before.cursorOffset)
    expect(draftFiles(scratch!), await context()).toEqual([])
    await tui.stop()
  }, 300_000)
})
