import { DRAFT_ENV, type DraftFiles } from "./draft-file.js"
import type { Log } from "./log.js"
import { NapDeferral } from "./park.js"
import { createPromptFinder, probePrompt } from "./prompt.js"

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
      if (text === "") return undefined
      try {
        stored = input.files.save(text)
      } catch (error) {
        return new NapDeferral(`cannot save the draft: ${describe(error)}`)
      }
      return { [DRAFT_ENV]: stored }
    },
    discard,
    dispose: () => finder.dispose(),
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
  const missing = probePrompt(input.renderer)
  if (missing) {
    input.log.once("draft not restored", { reason: `missing OpenCode internal ${missing}` })
    return () => {}
  }
  const finder = createPromptFinder(input.renderer)
  const deadline = input.now() + RESTORE_WAIT_MS
  let timer: unknown

  const finish = (message?: string, detail?: unknown) => {
    if (timer !== undefined) input.clearTimer(timer)
    timer = undefined
    finder.dispose()
    if (message) input.log.once(message, detail)
  }

  const attempt = () => {
    timer = undefined
    try {
      const found = finder.find()
      if (found.ok) {
        const wanted = input.text + found.editor.plainText
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
  return () => finish()
}
