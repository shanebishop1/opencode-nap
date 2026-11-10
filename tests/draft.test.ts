import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createDraftCarry, restoreDraft } from "../src/draft.js"
import { DRAFT_ENV, draftFiles } from "../src/draft-file.js"
import { NapDeferral } from "../src/park.js"
import { fakeEditor, fakeLog, fakeRenderer as renderer, settle, withoutCurrentEditor } from "./fakes.js"

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-carry-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe("createDraftCarry", () => {
  const carry = (r: unknown, unrestored?: string) => createDraftCarry({ renderer: r, files: draftFiles({}, tmp), unrestored: () => unrestored })

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

  it("ac-draft-dialog: carries a draft the prompt has not taken yet, ahead of anything typed", () => {
    const behindDialog = renderer()
    behindDialog.currentFocusedEditor = null
    const env = carry(behindDialog, "carried").capture() as Record<string, string>
    expect(readFileSync(env[DRAFT_ENV], "utf8")).toBe("carried")

    const r = renderer()
    r.prompt.text = " typed"
    expect(readFileSync((carry(r, "carried").capture() as Record<string, string>)[DRAFT_ENV], "utf8")).toBe("carried typed")
  })

  it("ac-draft-unreadable: a missing or throwing internal gives a deferral", () => {
    expect(carry(withoutCurrentEditor(renderer())).capture()).toEqual(new NapDeferral("cannot read the draft: missing OpenCode internal renderer.currentFocusedEditor"))

    const r = renderer()
    const draft = carry(r)
    Object.defineProperty(r, "currentFocusedEditor", { get: () => { throw new Error("renderer gone") } })
    expect(draft.capture()).toEqual(new NapDeferral("cannot read the draft: renderer gone"))

    const unknown = renderer()
    unknown.currentFocusedEditor = fakeEditor("typed", {})
    expect(carry(unknown).capture()).toEqual(new NapDeferral("cannot read the draft: the focused editor is not OpenCode's prompt"))
  })

  it("defers when the draft cannot be stored", () => {
    const r = renderer()
    r.prompt.text = "secret words"
    const files = { ...draftFiles({}, tmp), save: () => { throw new Error("ENOSPC: no space left on device") } }
    const deferral = createDraftCarry({ renderer: r, files, unrestored: () => undefined }).capture()
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
    const log = fakeLog()
    return { log, ...restoreDraft({ text, renderer: r, log }) }
  }

  it("ac-draft-restored: puts the text in the prompt with the cursor at the end, then stops listening", async () => {
    const r = renderer()
    const { log, unrestored } = restore(r)
    expect(r.prompt.text).toBe("draft ☃\nline two")
    expect(r.prompt.cursor).toBe(r.prompt.text.length)
    expect(unrestored()).toBeUndefined()
    expect(log.entries).toEqual([{ message: "draft restored", detail: { length: 16 } }])
    await settle()
    expect(r.count()).toBe(0)
  })

  it("ac-draft-dialog: waits, without a time limit, for the prompt a dialog holds back", async () => {
    const r = renderer()
    r.currentFocusedEditor = null
    const { log, unrestored } = restore(r)
    await settle()
    expect(unrestored()).toBe("draft ☃\nline two")
    const prompt = fakeEditor("", { suspend: true })
    r.currentFocusedEditor = prompt
    r.emit("focused_editor", prompt, null)
    // The traits arrive just after the focus.
    prompt.traits = { owner: "opencode", role: "prompt" }
    await settle()
    expect(prompt.text).toBe("draft ☃\nline two")
    expect(prompt.cursor).toBe(prompt.text.length)
    expect(log.entries.map(entry => entry.message)).toEqual(["draft restored"])
    expect(r.count()).toBe(0)
  })

  it("keeps text typed before the prompt was restored after the draft", () => {
    const r = renderer()
    r.prompt.text = "typed"
    restore(r, "draft ")
    expect(r.prompt.text).toBe("draft typed")
    expect(r.prompt.cursor).toBe(11)
  })

  it("logs once without the text when the prompt throws or does not keep it, or the internal is missing", () => {
    const throwing = renderer()
    throwing.prompt.setText = () => { throw new TypeError("cannot set private words") }
    expect(restore(throwing, "private words").log.entries).toEqual([
      { message: "draft not restored", detail: { reason: "the prompt editor threw", error: "TypeError" } },
    ])

    const ignoring = renderer()
    ignoring.prompt.setText = () => {}
    expect(restore(ignoring).log.entries).toEqual([{ message: "draft not restored", detail: { reason: "the prompt did not keep the text" } }])

    const missing = restore(undefined)
    expect(missing.log.entries).toEqual([
      { message: "draft not restored", detail: { reason: "missing OpenCode internal renderer.currentFocusedEditor" } },
    ])
    // Still carried by the next nap.
    expect(missing.unrestored()).toBe("draft ☃\nline two")
  })

  it("stops waiting when stopped", () => {
    const r = renderer()
    r.currentFocusedEditor = null
    const { log, stop } = restore(r)
    stop()
    expect(r.count()).toBe(0)
    r.emit("focused_editor", r.prompt, null)
    expect(r.prompt.text).toBe("")
    expect(log.entries).toEqual([])
  })
})
