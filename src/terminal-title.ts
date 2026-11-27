import { isObject, read } from "./read.js"

/** OpenTUI exposes a setter but no way to read a title it has already sent. */
export function watchTerminalTitle(renderer: unknown, onTitle: (title: string) => void): (() => void) | undefined {
  if (!isObject(renderer)) return
  try {
    const original = renderer.setTerminalTitle
    if (typeof original !== "function") return
    const own = Object.getOwnPropertyDescriptor(renderer, "setTerminalTitle")
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args)
      if (this === renderer && typeof args[0] === "string") onTitle(args[0])
      return result
    }
    renderer.setTerminalTitle = wrapped
    return () => {
      if (renderer.setTerminalTitle !== wrapped) return
      if (own) Object.defineProperty(renderer, "setTerminalTitle", own)
      else delete renderer.setTerminalTitle
    }
  } catch {
    // A renderer without a writable setter can still nap.
    return undefined
  }
}

export function terminalTitleDisabled(context: unknown): boolean {
  try {
    // The plugin context doesn't expose CLI config; the toggle reflects its current value.
    const keymap = read(context, "keymap")
    if (!isObject(keymap) || typeof keymap.commands !== "function") return false
    const commands: unknown = keymap.commands()
    return Array.isArray(commands) && commands.some(command =>
      read(command, "id") === "terminal.title.toggle" && read(command, "title") === "Enable terminal title")
  } catch {
    return false
  }
}

const DEFAULT_SESSION_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Mirrors OpenCode's route title effect when the live title wasn't observed. */
export function fallbackTerminalTitle(route: unknown, sessionTitle: unknown): string {
  if (read(route, "type") === "plugin") {
    const name = read(route, "name")
    return typeof name === "string" && name ? `OC | ${name}` : "OpenCode"
  }
  if (typeof sessionTitle !== "string" || !sessionTitle || DEFAULT_SESSION_TITLE.test(sessionTitle)) return "OpenCode"
  return `OC | ${sessionTitle.length > 40 ? sessionTitle.slice(0, 37) + "…" : sessionTitle}`
}
