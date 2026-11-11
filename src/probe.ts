import { isObject, read } from "./read.js"

export type Listener = (...args: unknown[]) => void

export interface Emitter {
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
}

/** The parts of the OpenCode TUI context the plugin uses, once the probe has checked them. */
export interface NapHost {
  ui: { router: { current(): unknown } }
  client: { server: { info(): Promise<unknown> } }
  data: { session: { get(sessionID: string): { title?: unknown; location?: { directory?: unknown } } | undefined } }
  renderer: Emitter & { keyInput: Emitter; stdin: unknown; controlState: unknown }
}

export type ProbeResult = { ok: true; host: NapHost; stdin: Emitter } | { ok: false; missing: string }

const isFunction = (value: unknown): boolean => typeof value === "function"

const isEmitter = (value: unknown): boolean => isObject(value) && isFunction(value.on) && isFunction(value.off)

// Checked in order; the first that fails is reported by name.
const checks: Array<[name: string, check: (context: unknown, stdin: unknown) => boolean]> = [
  ["ui.router.current", context => isFunction(read(context, "ui.router.current"))],
  ["client.server.info", context => isFunction(read(context, "client.server.info"))],
  ["data.session.get", context => isFunction(read(context, "data.session.get"))],
  ["renderer.on/off", context => isEmitter(read(context, "renderer"))],
  ["renderer.keyInput.on/off", context => isEmitter(read(context, "renderer.keyInput"))],
  // "explicit_suspended" while the terminal is handed to an external editor or the job is stopped.
  ["renderer.controlState", context => typeof read(context, "renderer.controlState") === "string"],
  // Mouse input is only seen on the raw stream, so it must be the one the renderer reads.
  ["renderer.stdin", (context, stdin) => isEmitter(stdin) && read(context, "renderer.stdin") === stdin],
]

/** Checks that every OpenCode internal the plugin uses is present with the expected shape. */
export function probe(context: unknown, stdin: unknown): ProbeResult {
  for (const [name, check] of checks) {
    let ok = false
    try {
      ok = check(context, stdin)
    } catch {
      // A getter that throws counts as missing.
    }
    if (!ok) return { ok: false, missing: name }
  }
  return { ok: true, host: context as NapHost, stdin: stdin as Emitter }
}
