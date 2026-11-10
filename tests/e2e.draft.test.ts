import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import {
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  e2eEnabled,
  startServer,
  startTuiWith,
  stopTuis,
  type Scratch,
} from "./e2e/harness.js"
import { NapRun, sleep, SPACE, stripEscapesSince, waitUntil, Watch, type Entry } from "./e2e/nap-run.js"
import type { PtyProcess } from "./e2e/pty.js"

const napOptions = { idleMinutes: 0.25 }
const NAP_TIMEOUT_MS = 40_000

let scratch: Scratch
let server: { process: PtyProcess; url: string }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** Draft files in the TUI's per-user draft directory under its TMPDIR. */
function draftPaths(): string[] {
  const dir = join(scratch.env.TMPDIR, `opencode-nap-${process.getuid?.() ?? "user"}`)
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : []
}

const draftsOnDisk = () => draftPaths().map(file => ({ mode: statSync(file).mode & 0o777, sha256: sha256(readFileSync(file, "utf8")) }))

/** Starts a TUI with the plugin and the observer on a new session, and waits for its prompt. */
async function openSession(name: string, options: Record<string, unknown> = {}) {
  const watch = await Watch.configure(scratch, name, { ...napOptions, ...options })
  const sessionID = await createSession(scratch, server.url)
  const tui = await startTuiWith(scratch, name, ["--server", server.url, "-s", sessionID, scratch.project])
  const run = new NapRun(tui, watch)
  await run.waitForWatching(1)
  await run.waitForInteractive(0)
  return { sessionID, tui, run, watch }
}

/** Waits until the observer's report on the prompt passes `check`. */
const promptWhere = (watch: Watch, check: (prompt: Entry) => boolean, timeoutMs: number): Promise<Entry> =>
  waitUntil(async () => {
    const { result } = await watch.ask("prompt")
    return check(result) ? result : undefined
  }, timeoutMs, "the prompt to match")

/** Waits for the nap, notes the draft files while napped, and wakes with Space. */
async function napAndWake(run: NapRun) {
  await run.waitForNap(NAP_TIMEOUT_MS).catch(async error => {
    throw new Error(`${error.message}\n${await run.context()}`)
  })
  const whileNapped = draftsOnDisk()
  const watching = await run.watchingCount()
  const offset = run.tui.output().length
  await run.wake(SPACE)
  await run.waitForWatching(watching + 1)
  return { whileNapped, offset }
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: the unsent draft survives a nap`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("ac-draft-restored, ac-draft-file, ac-draft-not-logged: a typed multi-line, non-ASCII draft comes back with the cursor at the end", async () => {
    const { tui, run, watch } = await openSession("restored")
    const typed = "hello wörld ☃ 日本語 "
    const pasted = "second line\nthird — “line” ✓"
    const draft = typed + pasted
    await run.typeDraft(typed)
    run.pasteDraft(pasted)
    const before = await promptWhere(watch, prompt => prompt.text === draft, 10_000)

    const { whileNapped, offset } = await napAndWake(run)
    expect(whileNapped, await run.context()).toEqual([{ mode: 0o600, sha256: sha256(draft) }])

    const after = await promptWhere(watch, prompt => prompt.text === draft, 30_000)
    expect(after.cursorOffset).toBe(before.cursorOffset)
    expect(after.logicalCursor).toEqual(before.logicalCursor)
    expect(stripEscapesSince(tui, offset)).toContain("third")
    expect(draftPaths()).toEqual([])
    expect((await watch.ask("state")).result.napEnv).toEqual([])

    const log = readFileSync(watch.napLog, "utf8")
    expect(log).toContain('"draft restored"')
    for (const part of ["wörld", "日本語", "second line", "third", "“line”"]) expect(log).not.toContain(part)
  }, 240_000)

  it("ac-draft-empty: an empty prompt naps without a draft file and wakes empty", async () => {
    const { run, watch } = await openSession("empty")
    const { whileNapped } = await napAndWake(run)
    expect(whileNapped, await run.context()).toEqual([])
    await promptWhere(watch, prompt => prompt.focused, 30_000)
    await sleep(1_000)
    expect((await watch.ask("prompt")).result.text).toBe("")
    expect((await watch.napEntries()).map(entry => entry.message)).not.toContain("draft restored")
  }, 240_000)

  it("ac-draft-off: with carryDraft false the typed text is not carried, so the restore above is the plugin's", async () => {
    const { run, watch } = await openSession("off", { carryDraft: false })
    await run.typeDraft("not carried")
    await promptWhere(watch, prompt => prompt.text === "not carried", 10_000)
    const { whileNapped } = await napAndWake(run)
    expect(whileNapped, await run.context()).toEqual([])
    await promptWhere(watch, prompt => prompt.focused, 30_000)
    await sleep(1_000)
    expect((await watch.ask("prompt")).result.text).toBe("")
  }, 240_000)

  it("ac-draft-large: a 1 MB draft comes back intact", async () => {
    // Set through the observer: OpenCode turns a large paste into a placeholder
    // rather than prompt text, and typing 1 MB through a terminal is too slow.
    const large = "A large draft line with ✓ and ü in it.\n".repeat(27_000).slice(0, 1024 * 1024)
    const { run, watch } = await openSession("large")
    expect((await watch.ask("set", large)).result.length).toBe(large.length)
    const before = await promptWhere(watch, prompt => prompt.sha256 === sha256(large), 10_000)

    const { whileNapped } = await napAndWake(run)
    expect(whileNapped, await run.context()).toEqual([{ mode: 0o600, sha256: sha256(large) }])
    const after = await promptWhere(watch, prompt => prompt.sha256 === sha256(large), 60_000)
    expect(after.cursorOffset).toBe(before.cursorOffset)
    expect(draftPaths()).toEqual([])
  }, 300_000)
})
