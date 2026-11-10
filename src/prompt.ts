import type { Emitter, Listener } from "./probe.js"

/** The parts of an OpenTUI edit buffer the plugin uses. */
export interface PromptEditor {
  readonly plainText: string
  readonly isDestroyed?: unknown
  setText(text: string): void
  gotoBufferEnd(): void
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const isEmitter = (value: unknown): value is Emitter =>
  isObject(value) && typeof value.on === "function" && typeof value.off === "function"

/**
 * OpenCode marks its session prompt with the traits `owner: "opencode"` and
 * `role: "prompt"`; dialog, palette and plugin editors have neither.
 */
export function isPromptEditor(value: unknown): value is PromptEditor {
  if (!isObject(value) || value.isDestroyed === true) return false
  const traits = value.traits
  return isObject(traits) && traits.owner === "opencode" && traits.role === "prompt" &&
    typeof value.plainText === "string" && typeof value.setText === "function" && typeof value.gotoBufferEnd === "function"
}

/** Names the internal the prompt is found through when it is missing. */
export function probePrompt(renderer: unknown): string | undefined {
  try {
    if (isObject(renderer) && "currentFocusedEditor" in renderer) return undefined
  } catch {
    // A proxy that throws counts as missing.
  }
  return "renderer.currentFocusedEditor"
}

export interface PromptTracker {
  /**
   * The prompt's unsent text, or undefined when no prompt has been mounted
   * since setup. Throws when it cannot be read.
   */
  text(): string | undefined
  dispose(): void
}

/**
 * Follows OpenCode's session prompt through focus changes and calls
 * `onPrompt` for each new one. A permission or question dialog destroys the
 * prompt (OpenCode keeps its text privately for the next prompt it mounts),
 * so the text is read as the prompt loses focus.
 */
export function trackPrompt(renderer: unknown, onPrompt: (editor: PromptEditor) => void = () => {}): PromptTracker {
  let prompt: PromptEditor | undefined
  let textWhenUnfocused: string | undefined
  let disposed = false
  const focused = (): unknown => (isObject(renderer) ? renderer.currentFocusedEditor : undefined)
  const notice = (editor: unknown) => {
    if (disposed || editor === prompt || !isPromptEditor(editor)) return
    prompt = editor
    textWhenUnfocused = undefined
    onPrompt(editor)
  }
  const onFocused: Listener = (next, previous) => {
    try {
      if (prompt !== undefined && previous === prompt) textWhenUnfocused = prompt.plainText
      notice(next)
    } catch {
      // Never throw into OpenCode; text() reports an unreadable prompt.
    }
    // OpenCode sets the prompt's traits just after focusing it.
    queueMicrotask(() => {
      try {
        notice(next)
      } catch {
        // As above.
      }
    })
  }
  const emitter = isEmitter(renderer) ? renderer : undefined
  try {
    emitter?.on("focused_editor", onFocused)
    // The prompt may have been focused before the plugin started.
    notice(focused())
  } catch {
    // The caller probes for what is missing.
  }

  return {
    text() {
      notice(focused())
      if (prompt === undefined) {
        // Without a prompt, nothing focused can hold a draft; an unknown editor might.
        if (isObject(focused())) throw new Error("the focused editor is not OpenCode's prompt")
        return undefined
      }
      if (prompt.isDestroyed !== true) return prompt.plainText
      if (textWhenUnfocused === undefined) throw new Error("the prompt was destroyed before its text could be read")
      return textWhenUnfocused
    },
    dispose() {
      disposed = true
      try {
        emitter?.off("focused_editor", onFocused)
      } catch {
        // Already turning off.
      }
    },
  }
}
