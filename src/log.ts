import { appendFileSync } from "node:fs"
import { isAbsolute } from "node:path"

export interface Log {
  write(message: string, detail?: unknown): void
  /** Writes a message only the first time it is seen by this log. */
  once(message: string, detail?: unknown): void
}

/**
 * Diagnostics sink. A TUI owns the terminal, so nothing is ever written to
 * stdout or stderr; lines go to the opt-in `debugLogFile` (an absolute path)
 * as JSON, and are dropped when it is not set.
 */
export function createLog(file: unknown): Log {
  const seen = new Set<string>()
  const write = (message: string, detail?: unknown): void => {
    if (typeof file !== "string" || !isAbsolute(file)) return
    const entry = { time: new Date().toISOString(), message, ...(detail === undefined ? {} : { detail }) }
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      // Diagnostics must never break the TUI.
    }
  }
  return {
    write,
    once(message, detail) {
      if (seen.has(message)) return
      seen.add(message)
      write(message, detail)
    },
  }
}
