import type { Emitter, Listener } from "./probe.js"

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

/** Names the internal the prompt is found through when it is missing. */
export function probePrompt(renderer: unknown): string | undefined {
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
    if (probePrompt(renderer) === undefined) remember((renderer as Record<string, unknown>).currentFocusedEditor)
  } catch {
    // find() reports what is missing.
  }

  return {
    find() {
      const missing = probePrompt(renderer)
      if (missing) return { ok: false, reason: `missing OpenCode internal ${missing}` }
      const host = renderer as Record<string, unknown>
      remember(host.currentFocusedEditor)
      const focused = [...remembered].reverse().find(isPromptEditor)
      if (focused) return { ok: true, editor: focused }
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
