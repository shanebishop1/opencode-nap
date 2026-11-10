import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  createDraftCarry,
  createPromptFinder,
  draftFiles,
  isPromptEditor,
  probeDraft,
  restoreDraft,
  RESTORE_WAIT_MS,
} from "../src/draft.js"
import { DRAFT_ENV } from "../src/draft-file.js"
import { NapDeferral } from "../src/park.js"
import { fakeContext, fakeEditor, FakeEmitter, fakeLog, fakeProcess } from "./fakes.js"

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-carry-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** A renderer whose empty prompt is focused and mounted. */
/** The renderer without the internal the draft is read through. */
const withoutCurrentEditor = (r: object) => {
  const copy: Record<string, unknown> = { ...r }
  delete copy.currentFocusedEditor
  return copy
}

const renderer = () => {
  const context = fakeContext(new FakeEmitter())
  return Object.assign(context.renderer, { prompt: context.prompt })
}

describe("isPromptEditor", () => {
  it("accepts OpenCode's session prompt and nothing else", () => {
    expect(isPromptEditor(fakeEditor("x"))).toBe(true)
    // A dialog prompt, a select or palette search field, an editor before its traits are set.
    expect(isPromptEditor(fakeEditor("x", { suspend: true }))).toBe(false)
    expect(isPromptEditor(fakeEditor("", { status: "FILTER" }))).toBe(false)
    expect(isPromptEditor(fakeEditor("x", { role: "prompt" }))).toBe(false)
    expect(isPromptEditor(fakeEditor("x", null))).toBe(false)
    expect(isPromptEditor({ ...fakeEditor("x"), isDestroyed: true })).toBe(false)
    expect(isPromptEditor({ traits: { owner: "opencode", role: "prompt" }, plainText: "x" })).toBe(false)
    expect(isPromptEditor(null)).toBe(false)
  })
})

describe("probeDraft", () => {
  it("names renderer.currentFocusedEditor when it is missing", () => {
    expect(probeDraft(renderer())).toBeUndefined()
    expect(probeDraft({ ...renderer(), currentFocusedEditor: null })).toBeUndefined()
    expect(probeDraft(withoutCurrentEditor(renderer()))).toBe("renderer.currentFocusedEditor")
    expect(probeDraft(undefined)).toBe("renderer.currentFocusedEditor")
    expect(probeDraft(new Proxy({}, { has() { throw new Error("gone") } }))).toBe("renderer.currentFocusedEditor")
  })
})

describe("createPromptFinder", () => {
  it("finds the focused prompt", () => {
    const r = renderer()
    const found = createPromptFinder(r).find()
    expect(found).toEqual({ ok: true, editor: r.currentFocusedEditor as never })
  })

  it("ac-draft-dialog: keeps the last focused prompt while a dialog leaves nothing focused", () => {
    const r = renderer()
    r.mounted = []
    const finder = createPromptFinder(r)
    const prompt = r.currentFocusedEditor
    r.currentFocusedEditor = null
    r.emit("focused_editor", null, prompt)
    expect(finder.find()).toEqual({ ok: true, editor: prompt as never })
  })

  it("prefers the prompt over a dialog's editor and a newer prompt over an older one", () => {
    const r = renderer()
    r.mounted = []
    const finder = createPromptFinder(r)
    const dialog = fakeEditor("dialog text", { suspend: true })
    r.currentFocusedEditor = dialog
    r.emit("focused_editor", dialog, null)
    expect(finder.find()).toEqual({ ok: true, editor: r.prompt as never })

    // Going home mounts a new prompt; the old one is destroyed.
    const home = fakeEditor("home")
    r.prompt.isDestroyed = true
    r.currentFocusedEditor = home
    r.emit("focused_editor", home, dialog)
    r.currentFocusedEditor = null
    expect(finder.find()).toEqual({ ok: true, editor: home as never })
  })

  it("checks the traits when the prompt is needed, since they are set after its first focus", () => {
    const r = renderer()
    r.mounted = []
    const early = fakeEditor("typed", { suspend: true })
    r.currentFocusedEditor = early
    const finder = createPromptFinder(r)
    r.currentFocusedEditor = null
    expect(finder.find()).toEqual({ ok: false, reason: "the prompt editor was not found" })
    early.traits = { suspend: true, owner: "opencode", role: "prompt" }
    expect(finder.find()).toEqual({ ok: true, editor: early as never })
  })

  it("falls back to the renderable tree for a prompt that was never focused", () => {
    const r = renderer()
    const hidden = r.prompt
    hidden.text = "draft"
    r.currentFocusedEditor = null
    r.root = { getChildren: () => [{ getChildren: () => [fakeEditor("x", {}), { getChildren: () => [hidden] }] }] }
    expect(createPromptFinder(r).find()).toEqual({ ok: true, editor: hidden as never })
  })

  it("refuses to guess between several never-focused prompts holding text", () => {
    const r = renderer()
    r.currentFocusedEditor = null
    r.mounted = [fakeEditor("one"), fakeEditor("two")]
    expect(createPromptFinder(r).find()).toEqual({ ok: false, reason: "more than one prompt holds text" })
    r.mounted = [fakeEditor(""), fakeEditor("two")]
    expect(createPromptFinder(r).find()).toEqual({ ok: true, editor: r.mounted[1] as never })
  })

  it("reports a missing internal, and stops listening on dispose", () => {
    const r = renderer()
    const finder = createPromptFinder(r)
    expect(r.count()).toBe(1)
    finder.dispose()
    expect(r.count()).toBe(0)
    expect(createPromptFinder(withoutCurrentEditor(r)).find()).toEqual({ ok: false, reason: "missing OpenCode internal renderer.currentFocusedEditor" })
  })
})

describe("draftFiles", () => {
  it("ac-draft-file: hands a draft over in a private file and takes it once", () => {
    const sent = draftFiles({}, tmp)
    const path = sent.save("one\ntwo ☃")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const env: NodeJS.ProcessEnv = { [DRAFT_ENV]: path, PATH: "/usr/bin" }
    const woken = draftFiles(env, tmp)
    expect(woken.take()).toBe("one\ntwo ☃")
    expect(existsSync(path)).toBe(false)
    expect(env).toEqual({ PATH: "/usr/bin" })
    expect(woken.take()).toBeUndefined()
  })

  it("ac-draft-large: carries 1 MB intact", () => {
    const text = "0123456789abcdef\n€".repeat(Math.ceil((1024 * 1024) / 18)).slice(0, 1024 * 1024)
    const path = draftFiles({}, tmp).save(text)
    expect(draftFiles({ [DRAFT_ENV]: path }, tmp).take()).toBe(text)
  })

  it("throws when the handed-over file cannot be read, and still removes the variable", () => {
    const env: NodeJS.ProcessEnv = { [DRAFT_ENV]: join(tmp, "missing") }
    expect(() => draftFiles(env, tmp).take()).toThrow("the draft file could not be read")
    expect(env[DRAFT_ENV]).toBeUndefined()
  })

  it("discards a stored draft", () => {
    const files = draftFiles({}, tmp)
    const path = files.save("x")
    files.discard(path)
    files.discard(path)
    expect(existsSync(path)).toBe(false)
  })
})

describe("createDraftCarry", () => {
  const carry = (r: unknown) => createDraftCarry({ renderer: r, files: draftFiles({}, tmp) })

  it("stores the prompt's text and returns the hand-over environment", () => {
    const r = renderer()
    r.prompt.text = "hello\nwörld"
    const env = carry(r).capture() as Record<string, string>
    expect(Object.keys(env)).toEqual([DRAFT_ENV])
    expect(readFileSync(env[DRAFT_ENV], "utf8")).toBe("hello\nwörld")
  })

  it("ac-draft-empty: an empty prompt stores nothing", () => {
    expect(carry(renderer()).capture()).toBeUndefined()
    expect(readdirSync(tmp)).toEqual([])
  })

  it("ac-draft-unreadable: a missing or throwing internal gives a deferral", () => {
    expect(carry(withoutCurrentEditor(renderer())).capture()).toEqual(new NapDeferral("cannot read the draft: missing OpenCode internal renderer.currentFocusedEditor"))

    const r = renderer()
    Object.defineProperty(r, "currentFocusedEditor", { get: () => { throw new Error("renderer gone") } })
    expect(carry(r).capture()).toEqual(new NapDeferral("cannot read the draft: renderer gone"))

    const unmounted = renderer()
    unmounted.currentFocusedEditor = null
    unmounted.mounted = []
    expect(carry(unmounted).capture()).toEqual(new NapDeferral("cannot read the draft: the prompt editor was not found"))
  })

  it("defers when the draft cannot be stored", () => {
    const r = renderer()
    r.prompt.text = "secret words"
    const files = { ...draftFiles({}, tmp), save: () => { throw new Error("ENOSPC: no space left on device") } }
    const deferral = createDraftCarry({ renderer: r, files }).capture()
    expect(deferral).toEqual(new NapDeferral("cannot save the draft: ENOSPC: no space left on device"))
  })

  it("replaces and discards drafts stored for naps that did not happen", () => {
    const r = renderer()
    const draft = carry(r)
    r.prompt.text = "first"
    const first = (draft.capture() as Record<string, string>)[DRAFT_ENV]
    r.prompt.text = "second"
    const second = (draft.capture() as Record<string, string>)[DRAFT_ENV]
    expect(existsSync(first)).toBe(false)
    expect(readdirSync(tmp)).toHaveLength(1)
    draft.discard()
    expect(existsSync(second)).toBe(false)
  })
})

describe("restoreDraft", () => {
  const restore = (r: unknown, text = "draft ☃\nline two") => {
    const fake = fakeProcess()
    const log = fakeLog()
    const stop = restoreDraft({ text, renderer: r, now: fake.proc.now, setTimer: fake.proc.setTimer, clearTimer: fake.proc.clearTimer, log })
    return { fake, log, stop }
  }

  it("ac-draft-restored: puts the text in the prompt with the cursor at the end", () => {
    const r = renderer()
    const { log, fake } = restore(r)
    expect(r.prompt.text).toBe("draft ☃\nline two")
    expect(r.prompt.cursor).toBe(r.prompt.text.length)
    expect(log.entries).toEqual([{ message: "draft restored", detail: { length: 16 } }])
    expect(fake.timers.size).toBe(0)
    expect(r.count()).toBe(0)
  })

  it("waits for a prompt that appears after setup", async () => {
    const r = renderer()
    r.currentFocusedEditor = null
    r.mounted = []
    const { fake, log } = restore(r)
    await fake.advance(2_000)
    expect(log.entries).toEqual([])
    const prompt = fakeEditor("", { suspend: true })
    r.currentFocusedEditor = prompt
    r.emit("focused_editor", prompt, null)
    await fake.advance(500)
    // The traits arrive a moment after the focus.
    prompt.traits = { owner: "opencode", role: "prompt" }
    await fake.advance(200)
    expect(prompt.text).toBe("draft ☃\nline two")
    expect(prompt.cursor).toBe(prompt.text.length)
    expect(log.entries.map(entry => entry.message)).toEqual(["draft restored"])
    expect(fake.timers.size).toBe(0)
  })

  it("keeps text typed before the prompt was restored after the draft", () => {
    const r = renderer()
    r.prompt.text = "typed"
    restore(r, "draft ")
    expect(r.prompt.text).toBe("draft typed")
    expect(r.prompt.cursor).toBe(11)
  })

  it("gives up after a bounded wait and logs once without the text", async () => {
    const r = renderer()
    r.currentFocusedEditor = null
    r.mounted = []
    const { fake, log } = restore(r, "private words")
    await fake.advance(RESTORE_WAIT_MS + 1_000)
    expect(log.entries).toEqual([{ message: "draft not restored", detail: { reason: "the prompt editor did not appear" } }])
    expect(fake.timers.size).toBe(0)
    expect(r.count()).toBe(0)
  })

  it("logs once when the prompt throws or does not keep the text", () => {
    const throwing = renderer()
    throwing.prompt.setText = () => { throw new TypeError("cannot set private words") }
    expect(restore(throwing, "private words").log.entries).toEqual([
      { message: "draft not restored", detail: { reason: "the prompt editor threw", error: "TypeError" } },
    ])

    const ignoring = renderer()
    ignoring.prompt.setText = () => {}
    expect(restore(ignoring).log.entries).toEqual([{ message: "draft not restored", detail: { reason: "the prompt did not keep the text" } }])

    expect(restore(undefined).log.entries).toEqual([
      { message: "draft not restored", detail: { reason: "missing OpenCode internal renderer.currentFocusedEditor" } },
    ])
  })

  it("stops waiting when stopped", async () => {
    const r = renderer()
    r.currentFocusedEditor = null
    r.mounted = []
    const { fake, log, stop } = restore(r)
    stop()
    expect(fake.timers.size).toBe(0)
    expect(r.count()).toBe(0)
    r.currentFocusedEditor = r.prompt
    await fake.advance(1_000)
    expect(r.prompt.text).toBe("")
    expect(log.entries).toEqual([])
  })
})
