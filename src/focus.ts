import type { Focus } from "./policy.js"
import type { Emitter } from "./probe.js"
import { read } from "./read.js"

export interface FocusState {
  focus: Focus
  unfocusedSince: number | undefined
}

export interface FocusSource {
  state(): FocusState
  dispose(): void
}

// The renderer may already have received focus before a plugin starts or
// reloads. This private snapshot is optional: an older or changed renderer
// still works from future events, without guessing that the window is away.
function rendererFocus(renderer: Emitter): Focus {
  try {
    const focused = read(renderer, "_terminalFocusState")
    return focused === true ? "focused" : focused === false ? "unfocused" : "unknown"
  } catch {
    return "unknown"
  }
}

/** Terminal focus, including reports received before setup. `onChange` runs only after later changes. */
export function createFocusSource(input: { renderer: Emitter; now: () => number; onChange?: () => void }): FocusSource {
  const initial = rendererFocus(input.renderer)
  // The earlier blur's time is not known; allow the full debounce from now.
  let current: FocusState = { focus: initial, unfocusedSince: initial === "unfocused" ? input.now() : undefined }

  const onFocus = () => {
    if (current.focus === "focused") return
    current = { focus: "focused", unfocusedSince: undefined }
    input.onChange?.()
  }
  const onBlur = () => {
    // A repeated blur keeps the time focus was first lost.
    if (current.focus === "unfocused") return
    current = { focus: "unfocused", unfocusedSince: input.now() }
    input.onChange?.()
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
