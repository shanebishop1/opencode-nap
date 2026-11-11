import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { DRAFT_ENV, draftFiles, type DraftFiles } from "../src/draft-file.js"
import { createLog, type Log } from "../src/log.js"
import { startNap } from "../src/tui.js"
import { fakeContext, fakeLog, fakeProcess, settle } from "./fakes.js"

const IDLE_MS = 60_000
const DRAFT = "Refactor the parser\nso that “quotes” work — ünïcödé ☃ 日本語"

let tmp = ""
let dir = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-tui-draft-"))
  dir = join(tmp, "drafts")
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

type Setup = {
  options?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  drafts?: DraftFiles
  log?: Log
  edit?: (context: ReturnType<typeof fakeContext>) => void
  /** Runs once the plugin is watching. */
  after?: (context: ReturnType<typeof fakeContext>) => void
}

async function start(setup: Setup = {}) {
  const env = setup.env ?? {}
  const files = setup.drafts ?? draftFiles(env, dir)
  // A real exec that works never returns, so nothing would discard the draft after it.
  let replaced = false
  const fake = fakeProcess({ drafts: { ...files, discard: path => { if (!replaced) files.discard(path) } } })
  const execve = fake.proc.execve
  fake.proc.execve = (...args) => {
    execve(...args)
    replaced = true
  }
  const context = fakeContext(fake.stdin)
  setup.edit?.(context)
  const log = setup.log ?? fakeLog()
  const cleanup = startNap(context, { idleMinutes: IDLE_MS / 60_000, ...setup.options }, log, fake.proc)
  await settle()
  setup.after?.(context)
  return { fake, context, log, cleanup, env }
}

const messages = (log: Log) => (log as ReturnType<typeof fakeLog>).entries.map(entry => entry.message)

const draftsOnDisk = () => (existsSync(dir) ? readdirSync(dir) : [])

/** Naps with the prompt holding `text` and returns the woken TUI's environment. */
async function napWith(text: string, setup: Setup = {}) {
  const napped = await start({ ...setup, edit: context => { context.prompt.text = text; setup.edit?.(context) } })
  await napped.fake.advance(IDLE_MS + 5_000)
  expect(napped.fake.execs).toHaveLength(1)
  return { ...napped, wokenEnv: { ...napped.fake.execs[0].env } }
}

describe("draft carry-over", () => {
  it("ac-draft-restored, ac-draft-file: the draft travels in a private file and comes back with the cursor at the end", async () => {
    const { wokenEnv } = await napWith(DRAFT)
    const path = wokenEnv[DRAFT_ENV]
    expect(path).toBeString()
    expect(statSync(path!).mode & 0o777).toBe(0o600)
    expect(readFileSync(path!, "utf8")).toBe(DRAFT)

    // The woken TUI's prompt appears about 1.5 s after setup.
    const woken = await start({ env: wokenEnv, edit: context => { context.renderer.currentFocusedEditor = null } })
    expect(woken.env[DRAFT_ENV]).toBeUndefined()
    expect(existsSync(path!)).toBe(false)
    await woken.fake.advance(1_500)
    woken.context.renderer.currentFocusedEditor = woken.context.prompt
    woken.context.renderer.emit("focused_editor", woken.context.prompt, null)
    await woken.fake.advance(200)
    expect(woken.context.prompt.text).toBe(DRAFT)
    expect(woken.context.prompt.cursor).toBe(DRAFT.length)
    expect(messages(woken.log)).toContain("draft restored")
  })

  it("ac-draft-empty: an empty prompt naps without a draft file and wakes empty", async () => {
    const { wokenEnv } = await napWith("")
    expect(wokenEnv[DRAFT_ENV]).toBeUndefined()
    expect(draftsOnDisk()).toEqual([])
    const woken = await start({ env: wokenEnv })
    expect(woken.context.prompt.text).toBe("")
    expect(messages(woken.log)).toEqual(["watching"])
  })

  it("ac-draft-off: with carryDraft false the draft is never read and the woken prompt is empty", async () => {
    let reads = 0
    let listening = 0
    const { wokenEnv } = await napWith("", {
      options: { carryDraft: false },
      edit: context => {
        Object.defineProperty(context.prompt, "plainText", { get: () => { reads++; return "unsent" } })
      },
      // Only the focus source's focus and blur: nothing follows the prompt.
      after: context => { listening = context.renderer.count() },
    })
    expect(listening).toBe(2)
    expect(reads).toBe(0)
    expect(wokenEnv[DRAFT_ENV]).toBeUndefined()
    expect(draftsOnDisk()).toEqual([])
    const woken = await start({ env: wokenEnv, options: { carryDraft: false } })
    expect(woken.context.prompt.text).toBe("")
  })

  it("ac-draft-dialog: a dialog that destroys the prompt does not stop the nap or lose the draft", async () => {
    const dialog = (context: ReturnType<typeof fakeContext>) => {
      context.renderer.currentFocusedEditor = null
      context.renderer.emit("focused_editor", null, context.prompt)
      context.prompt.isDestroyed = true
      Object.defineProperty(context.prompt, "plainText", { get: () => { throw new Error("EditBuffer is destroyed") } })
    }
    const napped = await napWith(DRAFT, { after: dialog })

    // Woken with the dialog still showing, so no prompt mounts; it naps again with the draft.
    const behindDialog = await napWith("", { env: napped.wokenEnv, edit: context => { context.renderer.currentFocusedEditor = null } })
    expect(readFileSync(behindDialog.wokenEnv[DRAFT_ENV]!, "utf8")).toBe(DRAFT)

    // The dialog is answered after this wake, and the prompt mounts.
    const woken = await start({ env: behindDialog.wokenEnv, edit: context => { context.renderer.currentFocusedEditor = null } })
    await woken.fake.advance(60_000)
    woken.context.renderer.currentFocusedEditor = woken.context.prompt
    woken.context.renderer.emit("focused_editor", woken.context.prompt, null)
    expect(woken.context.prompt.text).toBe(DRAFT)
  })

  it("ac-draft-unreadable: a missing internal is reported at setup, skips each nap with one log line, and naps once it is back", async () => {
    const { fake, context, log } = await start({
      edit: context => {
        context.prompt.text = DRAFT
        delete (context.renderer as Partial<typeof context.renderer>).currentFocusedEditor
      },
    })
    expect((log as ReturnType<typeof fakeLog>).entries[0]).toEqual({
      message: "draft unavailable: missing OpenCode internal",
      detail: { name: "renderer.currentFocusedEditor" },
    })
    await fake.advance(IDLE_MS + 60_000)
    expect(fake.execs).toHaveLength(0)
    expect(messages(log)).toEqual([
      "draft unavailable: missing OpenCode internal",
      "watching",
      "nap skipped: cannot read the draft: missing OpenCode internal renderer.currentFocusedEditor",
    ])
    context.renderer.currentFocusedEditor = context.prompt
    await fake.advance(5_000)
    expect(fake.execs).toHaveLength(1)
    expect(readFileSync(fake.execs[0].env[DRAFT_ENV]!, "utf8")).toBe(DRAFT)
  })

  it("deletes the stored draft when input arrives before the exec, or the exec fails", async () => {
    const files = draftFiles({}, dir)
    const saved: string[] = []
    let typeKey = () => {}
    const { fake } = await start({
      // A key press just after the first draft was stored.
      drafts: { ...files, save: text => { saved.push(files.save(text)); if (saved.length === 1) typeKey(); return saved.at(-1)! } },
      edit: context => {
        context.prompt.text = DRAFT
        typeKey = () => context.renderer.keyInput.emit("keypress", { name: "a" })
      },
    })
    await fake.advance(IDLE_MS + 5_000)
    expect(saved).toHaveLength(1)
    expect(fake.execs).toHaveLength(0)
    expect(draftsOnDisk()).toEqual([])

    fake.state.execveError = new Error("EACCES")
    await fake.advance(IDLE_MS + 5_000)
    expect(saved).toHaveLength(2)
    expect(fake.execs).toHaveLength(1)
    expect(draftsOnDisk()).toEqual([])
  })

  it("restores a carried draft even when the plugin is now turned off", async () => {
    const { wokenEnv } = await napWith(DRAFT)
    const woken = await start({ env: wokenEnv, options: { enabled: false } })
    expect(woken.context.prompt.text).toBe(DRAFT)
    expect(messages(woken.log)).toEqual(["draft restored", "refused"])
  })

  it("logs once when the handed-over file is gone", async () => {
    const woken = await start({ env: { [DRAFT_ENV]: join(dir, "missing") } })
    expect((woken.log as ReturnType<typeof fakeLog>).entries[0]).toEqual({
      message: "draft not restored",
      detail: { reason: "the handed-over draft could not be restored" },
    })
    expect(woken.env[DRAFT_ENV]).toBeUndefined()
  })

  it("cleans stale drafts at setup", async () => {
    let cleaned = 0
    await start({ drafts: { ...draftFiles({}, dir), cleanStale: () => { cleaned++ } } })
    expect(cleaned).toBe(1)
  })

  it("ac-draft-not-logged: a nap and wake with debug logging on never writes the draft text", async () => {
    const debugLogFile = join(tmp, "nap.log")
    const log = createLog(debugLogFile)
    const { wokenEnv } = await napWith(DRAFT, { log, options: { debugLogFile } })
    const woken = await start({ env: wokenEnv, log, options: { debugLogFile } })
    expect(woken.context.prompt.text).toBe(DRAFT)
    // A failed restore and a deferral as well.
    await start({ env: { [DRAFT_ENV]: join(dir, "missing") }, log, options: { debugLogFile } })
    const failing = await start({ log, options: { debugLogFile }, edit: context => { context.prompt.text = DRAFT }, after: context => {
      context.prompt.isDestroyed = true
      context.renderer.currentFocusedEditor = null
    } })
    await failing.fake.advance(IDLE_MS + 5_000)

    const written = readFileSync(debugLogFile, "utf8")
    const lines = written.trim().split("\n").map(line => JSON.parse(line).message)
    for (const message of ["napping", "draft restored", "draft not restored", "nap skipped: cannot read the draft: the prompt editor threw"]) {
      expect(lines).toContain(message)
    }
    for (const part of [DRAFT, ...DRAFT.split(/\s+/).filter(word => word.length > 3)]) {
      expect(written).not.toContain(part)
      expect(written).not.toContain(JSON.stringify(part).slice(1, -1))
    }
  })

  it("ac-draft-not-logged: logs only route metadata, not the starting prompt or unknown fields", async () => {
    const debugLogFile = join(tmp, "nap.log")
    const text = "PRIVATE_STARTING_DRAFT_86f593"
    for (const type of ["session", "home", "plugin"]) {
      const napped = await napWith(text, {
        log: createLog(debugLogFile),
        edit: context => {
          context.route = { type, sessionID: "ses_abc", prompt: { text, files: [] }, data: { text }, unknown: text }
        },
      })
      napped.cleanup()
    }
    const written = readFileSync(debugLogFile, "utf8")
    expect(written).not.toContain(text)
    const naps = written.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.message === "napping")
    expect(naps.map(line => line.detail)).toEqual([
      { rule: "idle", route: { type: "session", sessionID: "ses_abc" } },
      { rule: "idle", route: { type: "other" } },
      { rule: "idle", route: { type: "other" } },
    ])
  })

  it("ac-draft-not-logged: read and save errors cannot quote the draft in the log", async () => {
    const debugLogFile = join(tmp, "nap.log")
    const text = "PRIVATE_DRAFT_ERROR_59ccad"
    for (const failure of ["read", "save"]) {
      const files = draftFiles({}, dir)
      const failing = await start({
        log: createLog(debugLogFile),
        drafts: failure === "save" ? { ...files, save: text => { throw new Error(`could not save ${text}`) } } : files,
        edit: context => { context.prompt.text = text },
        after: context => {
          if (failure === "read") Object.defineProperty(context.prompt, "plainText", { get: () => { throw new Error(`could not read ${text}`) } })
        },
      })
      await failing.fake.advance(IDLE_MS + 10_000)
      expect(failing.fake.execs).toHaveLength(0)
      failing.cleanup()
    }
    const written = readFileSync(debugLogFile, "utf8")
    expect(written).not.toContain(text)
    const skipped = written.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.message.startsWith("nap skipped:"))
    expect(skipped.map(line => line.message)).toEqual([
      "nap skipped: cannot read the draft: the prompt editor threw",
      "nap skipped: cannot save the draft: the draft file could not be written",
    ])
  })

  it("ac-draft-not-logged: hand-over and restore errors cannot quote the draft in the log", async () => {
    const debugLogFile = join(tmp, "nap.log")
    const text = "PRIVATE_RESTORE_ERROR_192c8e"
    const files = draftFiles({}, dir)
    for (const failure of ["take", "restore"]) {
      const failing = await start({
        log: createLog(debugLogFile),
        drafts: { ...files, take: () => {
          if (failure === "take") throw new Error(`could not take ${text}`)
          return text
        } },
        edit: context => { context.prompt.setText = text => { throw new Error(`could not restore ${text}`) } },
      })
      failing.cleanup()
    }
    const written = readFileSync(debugLogFile, "utf8")
    expect(written).not.toContain(text)
    const entries = written.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.message === "draft not restored")
    expect(entries.map(line => line.detail)).toEqual([
      { reason: "the handed-over draft could not be restored" },
      { reason: "the prompt editor threw", error: "Error" },
    ])
  })
})
