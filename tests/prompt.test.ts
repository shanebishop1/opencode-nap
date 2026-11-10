import { describe, expect, it } from "bun:test"
import { isPromptEditor, probePrompt, trackPrompt } from "../src/prompt.js"
import { fakeEditor, fakeRenderer as renderer, settle, withoutCurrentEditor } from "./fakes.js"

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

describe("trackPrompt", () => {
  it("reads the focused prompt", () => {
    const r = renderer()
    r.prompt.text = "draft"
    expect(trackPrompt(r).text()).toBe("draft")
  })

  it("ac-draft-dialog: keeps the text of a prompt a dialog destroyed, read as it lost focus", () => {
    const r = renderer()
    const tracker = trackPrompt(r)
    r.prompt.text = "draft"
    r.currentFocusedEditor = null
    r.emit("focused_editor", null, r.prompt)
    r.prompt.isDestroyed = true
    Object.defineProperty(r.prompt, "plainText", { get: () => { throw new Error("EditBuffer is destroyed") } })
    expect(tracker.text()).toBe("draft")
  })

  it("follows a new prompt, noticed once OpenCode has set its traits", async () => {
    const r = renderer()
    const seen: unknown[] = []
    const tracker = trackPrompt(r, editor => seen.push(editor))
    expect(seen).toEqual([r.prompt])
    const next = fakeEditor("next", { suspend: true })
    r.currentFocusedEditor = next
    r.emit("focused_editor", next, r.prompt)
    next.traits = { suspend: true, owner: "opencode", role: "prompt" }
    await settle()
    expect(seen).toEqual([r.prompt, next])
    expect(tracker.text()).toBe("next")
  })

  it("does not take a dialog's editor for the prompt", () => {
    const r = renderer()
    const tracker = trackPrompt(r)
    r.prompt.text = "draft"
    const answer = fakeEditor("custom answer", { status: "ANSWER" })
    r.currentFocusedEditor = answer
    r.emit("focused_editor", answer, r.prompt)
    expect(tracker.text()).toBe("draft")
  })

  it("has no text before any prompt mounts, unless an unknown editor is focused", () => {
    const r = renderer()
    r.currentFocusedEditor = null
    const tracker = trackPrompt(r)
    expect(tracker.text()).toBeUndefined()
    r.currentFocusedEditor = fakeEditor("typed", {})
    expect(() => tracker.text()).toThrow("the focused editor is not OpenCode's prompt")
  })

  it("reports a prompt destroyed before its text was read", () => {
    const r = renderer()
    const tracker = trackPrompt(r)
    r.prompt.isDestroyed = true
    r.currentFocusedEditor = null
    expect(() => tracker.text()).toThrow("the prompt was destroyed before its text could be read")
  })

  it("stops listening on dispose", () => {
    const r = renderer()
    const tracker = trackPrompt(r)
    expect(r.count()).toBe(1)
    tracker.dispose()
    expect(r.count()).toBe(0)
  })
})
