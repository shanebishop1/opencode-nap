import type { Focus } from "./policy.js"
import type { Emitter } from "./probe.js"

export interface FocusState {
  focus: Focus
  unfocusedSince: number | undefined
}

export interface FocusSource {
  state(): FocusState
  dispose(): void
}

/** Terminal focus from the renderer's "focus" and "blur" events; unknown until the first one. */
export function createFocusSource(input: { renderer: Emitter; now: () => number }): FocusSource {
  let current: FocusState = { focus: "unknown", unfocusedSince: undefined }

  const onFocus = () => {
    current = { focus: "focused", unfocusedSince: undefined }
  }
  const onBlur = () => {
    // A repeated blur keeps the time focus was first lost.
    if (current.focus !== "unfocused") current = { focus: "unfocused", unfocusedSince: input.now() }
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  return {
    state: () => ({ ...current }),
    dispose() {
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
