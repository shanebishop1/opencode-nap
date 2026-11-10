import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createDraftCarry, restoreDraft, RESTORE_WAIT_MS } from "../src/draft.js"
import { DRAFT_ENV, draftFiles } from "../src/draft-file.js"
import { NapDeferral } from "../src/park.js"
import { fakeEditor, fakeLog, fakeProcess, fakeRenderer as renderer, withoutCurrentEditor } from "./fakes.js"

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-carry-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
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
