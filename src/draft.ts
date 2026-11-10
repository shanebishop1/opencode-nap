import { unlinkSync } from "node:fs"
import { cleanStaleDrafts, DRAFT_ENV, draftDir, readAndDeleteDraft, takeDraftPath, writeDraft } from "./draft-file.js"
import type { Log } from "./log.js"
import { NapDeferral } from "./park.js"
import type { Emitter, Listener } from "./probe.js"

/** Draft files, injected so tests can keep them out of the real temp directory and environment. */
export interface DraftFiles {
  /**
   * Takes the draft left by the nap that started this TUI and deletes its file
   * and the hand-over variable. Undefined when there was none; throws when the
   * file could not be read.
   */
  take(): string | undefined
  /** Stores a non-empty draft and returns its path. */
  save(text: string): string
  /** Deletes a stored draft that was never handed over. */
  discard(path: string): void
  /** Deletes draft files left by naps that never woke. */
  cleanStale(): void
}

export function draftFiles(env: NodeJS.ProcessEnv = process.env, dir: string = draftDir()): DraftFiles {
  return {
    take() {
      const path = takeDraftPath(env)
      if (path === undefined) return undefined
      const text = readAndDeleteDraft(path, dir)
      if (text === undefined) throw new Error("the draft file could not be read")
      return text
    },
    save(text) {
      const path = writeDraft(text, dir)
      if (path === undefined) throw new Error("an empty draft is not stored")
      return path
    },
    discard(path) {
      try {
        unlinkSync(path)
      } catch {
        // Already gone; nothing more to do.
      }
    },
    cleanStale() {
      cleanStaleDrafts(dir)
    },
  }
}

/** The parts of an OpenTUI edit buffer the plugin uses. */
export interface PromptEditor {
  readonly plainText: string
  setText(text: string): void
  gotoBufferEnd(): void
}

export type FindResult = { ok: true; editor: PromptEditor } | { ok: false; reason: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isEmitter = (value: unknown): value is Emitter =>
  isObject(value) && typeof value.on === "function" && typeof value.off === "function"

/**
 * OpenCode marks its session prompt with the traits `owner: "opencode"` and
 * `role: "prompt"`; dialog, palette and plugin editors have neither. The
 * traits are set just after the prompt is first focused, so they are checked
 * when the prompt is needed rather than when it is seen.
 */
export function isPromptEditor(value: unknown): value is PromptEditor {
  if (!isObject(value) || value.isDestroyed === true) return false
  const traits = value.traits
  return isObject(traits) && traits.owner === "opencode" && traits.role === "prompt" &&
    typeof value.plainText === "string" && typeof value.setText === "function" && typeof value.gotoBufferEnd === "function"
}

/** Names the internal the draft is read through when it is missing. */
export function probeDraft(renderer: unknown): string | undefined {
  try {
    if (isObject(renderer) && "currentFocusedEditor" in renderer) return undefined
  } catch {
    // A proxy that throws counts as missing.
  }
  return "renderer.currentFocusedEditor"
}

// Enough for every prompt a TUI mounts at once (one per open tab) and some old ones.
const MAX_REMEMBERED = 8
const MAX_TREE_NODES = 20_000

// Prompt editors in the renderable tree, for a prompt that was never focused:
// one hidden by a dialog shown as the TUI started.
function mountedPrompts(renderer: Record<string, unknown>): PromptEditor[] {
  const found: PromptEditor[] = []
  const queue: unknown[] = [renderer.root]
  for (let next = 0; next < queue.length && next < MAX_TREE_NODES; next++) {
    const node = queue[next]
    if (isPromptEditor(node)) found.push(node)
    if (!isObject(node) || typeof node.getChildren !== "function") continue
    const children: unknown = node.getChildren()
    if (Array.isArray(children)) queue.push(...children)
  }
  return found
}

export interface PromptFinder {
  find(): FindResult
  dispose(): void
}

/**
 * Finds the session prompt. While a permission or question dialog is shown
 * nothing is focused, so the finder remembers each editor that gains focus
 * and falls back to the most recently focused prompt that still exists.
 */
export function createPromptFinder(renderer: unknown): PromptFinder {
  let remembered: unknown[] = []
  const remember = (editor: unknown) => {
    if (!isObject(editor)) return
    remembered = [...remembered.filter(seen => seen !== editor && !(isObject(seen) && seen.isDestroyed === true)), editor]
      .slice(-MAX_REMEMBERED)
  }
  const onFocused: Listener = editor => remember(editor)
  const emitter = isEmitter(renderer) ? renderer : undefined
  try {
    emitter?.on("focused_editor", onFocused)
    // The prompt may have been focused before the plugin started.
    if (probeDraft(renderer) === undefined) remember((renderer as Record<string, unknown>).currentFocusedEditor)
  } catch {
    // find() reports what is missing.
  }

  return {
    find() {
      const missing = probeDraft(renderer)
      if (missing) return { ok: false, reason: `missing OpenCode internal ${missing}` }
      const host = renderer as Record<string, unknown>
      remember(host.currentFocusedEditor)
      for (const editor of [...remembered].reverse()) {
        if (isPromptEditor(editor)) return { ok: true, editor }
      }
      let mounted: PromptEditor[]
      try {
        mounted = mountedPrompts(host)
      } catch {
        mounted = []
      }
      if (mounted.length === 0) return { ok: false, reason: "the prompt editor was not found" }
      // Without a focus to go by, only an unambiguous draft is carried.
      const holdingText = mounted.filter(editor => editor.plainText !== "")
      if (holdingText.length > 1) return { ok: false, reason: "more than one prompt holds text" }
      return { ok: true, editor: holdingText[0] ?? mounted[0] }
    },
    dispose() {
      try {
        emitter?.off("focused_editor", onFocused)
      } catch {
        // Already turning off.
      }
      remembered = []
    },
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface DraftCarry {
  /** For park's beforeNap: stores the draft and returns the environment that hands it over, or a deferral. */
  capture(): Record<string, string> | NapDeferral | undefined
  /** Deletes the draft stored for a nap that did not happen. */
  discard(): void
  dispose(): void
}

/** Carries the prompt's text across a nap. Draft text never reaches the log. */
export function createDraftCarry(input: { renderer: unknown; files: DraftFiles }): DraftCarry {
  const finder = createPromptFinder(input.renderer)
  let stored: string | undefined

  const discard = () => {
    if (stored !== undefined) input.files.discard(stored)
    stored = undefined
  }

  return {
    capture() {
      discard()
      let text: string
      try {
        const found = finder.find()
        if (!found.ok) return new NapDeferral(`cannot read the draft: ${found.reason}`)
        text = found.editor.plainText
      } catch (error) {
        return new NapDeferral(`cannot read the draft: ${describe(error)}`)
      }
      if (typeof text !== "string") return new NapDeferral("cannot read the draft: the prompt text is not a string")
      if (text === "") return undefined
      try {
        stored = input.files.save(text)
      } catch (error) {
        return new NapDeferral(`cannot save the draft: ${describe(error)}`)
      }
      return { [DRAFT_ENV]: stored }
    },
    discard,
    dispose() {
      finder.dispose()
    },
  }
}

// The prompt is focused about 1.5 s after wake; allow for a slow machine.
export const RESTORE_WAIT_MS = 30_000
const RESTORE_POLL_MS = 100

export interface RestoreInput {
  text: string
  renderer: unknown
  now: () => number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log: Log
}

/**
 * Puts a carried draft into the prompt, with the cursor at the end, once the
 * prompt exists. Anything typed before then is kept after the draft. Returns
 * a function that stops waiting.
 */
export function restoreDraft(input: RestoreInput): () => void {
  const finder = createPromptFinder(input.renderer)
  const deadline = input.now() + RESTORE_WAIT_MS
  let timer: unknown
  let done = false

  const finish = (message?: string, detail?: unknown) => {
    done = true
    if (timer !== undefined) input.clearTimer(timer)
    timer = undefined
    finder.dispose()
    if (message) input.log.once(message, detail)
  }

  const attempt = () => {
    timer = undefined
    if (done) return
    const missing = probeDraft(input.renderer)
    if (missing) {
      finish("draft not restored", { reason: `missing OpenCode internal ${missing}` })
      return
    }
    try {
      const found = finder.find()
      if (found.ok) {
        const typed = found.editor.plainText
        const wanted = typed ? input.text + typed : input.text
        found.editor.setText(wanted)
        found.editor.gotoBufferEnd()
        if (found.editor.plainText === wanted) finish("draft restored", { length: input.text.length })
        else finish("draft not restored", { reason: "the prompt did not keep the text" })
        return
      }
    } catch (error) {
      // The name only: a message could quote the text it failed on.
      finish("draft not restored", { reason: "the prompt editor threw", error: error instanceof Error ? error.name : typeof error })
      return
    }
    if (input.now() >= deadline) finish("draft not restored", { reason: "the prompt editor did not appear" })
    else timer = input.setTimer(attempt, RESTORE_POLL_MS)
  }

  attempt()
  return () => {
    if (!done) finish()
  }
}
