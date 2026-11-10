import { DRAFT_ENV, type DraftFiles } from "./draft-file.js"
import type { Log } from "./log.js"
import { NapDeferral } from "./park.js"
import { probePrompt, trackPrompt, type PromptEditor } from "./prompt.js"

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface DraftCarry {
  /** For park's beforeNap: stores the draft and returns the environment that hands it over, or a deferral. */
  capture(): Record<string, string> | NapDeferral | undefined
  /** Deletes the draft stored for a nap that did not happen. */
  discard(): void
  dispose(): void
}

export interface DraftCarryInput {
  renderer: unknown
  files: DraftFiles
  /** A draft carried in by the last nap that the prompt has not taken yet. */
  unrestored: () => string | undefined
}

/** Carries the prompt's text across a nap. Draft text never reaches the log. */
export function createDraftCarry(input: DraftCarryInput): DraftCarry {
  const prompt = trackPrompt(input.renderer)
  let stored: string | undefined

  const discard = () => {
    if (stored !== undefined) input.files.discard(stored)
    stored = undefined
  }

  return {
    capture() {
      discard()
      const missing = probePrompt(input.renderer)
      if (missing) return new NapDeferral(`cannot read the draft: missing OpenCode internal ${missing}`)
      let text: string
      try {
        text = (input.unrestored() ?? "") + (prompt.text() ?? "")
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
    dispose: () => prompt.dispose(),
  }
}

export interface DraftRestore {
  /** The draft while the prompt has not taken it. */
  unrestored(): string | undefined
  stop(): void
}

/**
 * Puts a carried draft into the next session prompt, with the cursor at the
 * end. Anything typed before then is kept after the draft. A dialog shown at
 * wake holds the prompt back until it is answered, so there is no time limit.
 */
export function restoreDraft(input: { text: string; renderer: unknown; log: Log }): DraftRestore {
  let unrestored: string | undefined = input.text
  const missing = probePrompt(input.renderer)
  if (missing) {
    input.log.once("draft not restored", { reason: `missing OpenCode internal ${missing}` })
    return { unrestored: () => unrestored, stop: () => {} }
  }

  const put = (editor: PromptEditor) => {
    if (unrestored === undefined) return
    const wanted = unrestored + editor.plainText
    unrestored = undefined
    // Later, since this may run while the tracker is still being created.
    queueMicrotask(() => tracker.dispose())
    try {
      editor.setText(wanted)
      editor.gotoBufferEnd()
      if (editor.plainText === wanted) input.log.once("draft restored", { length: input.text.length })
      else input.log.once("draft not restored", { reason: "the prompt did not keep the text" })
    } catch (error) {
      // The name only: a message could quote the text it failed on.
      input.log.once("draft not restored", { reason: "the prompt editor threw", error: error instanceof Error ? error.name : typeof error })
    }
  }
  const tracker = trackPrompt(input.renderer, put)
  return { unrestored: () => unrestored, stop: () => tracker.dispose() }
}
