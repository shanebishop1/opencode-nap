import { describe, expect, it } from "bun:test"
import { createPromptFinder, isPromptEditor, probePrompt } from "../src/prompt.js"
import { fakeEditor, fakeRenderer as renderer, withoutCurrentEditor } from "./fakes.js"

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

describe("probePrompt", () => {
  it("names renderer.currentFocusedEditor when it is missing", () => {
    expect(probePrompt(renderer())).toBeUndefined()
    expect(probePrompt({ ...renderer(), currentFocusedEditor: null })).toBeUndefined()
    expect(probePrompt(withoutCurrentEditor(renderer()))).toBe("renderer.currentFocusedEditor")
    expect(probePrompt(undefined)).toBe("renderer.currentFocusedEditor")
    expect(probePrompt(new Proxy({}, { has() { throw new Error("gone") } }))).toBe("renderer.currentFocusedEditor")
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
