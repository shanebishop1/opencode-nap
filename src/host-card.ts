import { napCard, plainCard } from "./card.js"
import { captureFrame } from "./frame.js"
import { frameCard } from "./frame-card.js"
import { defaultPalette, readPalette } from "./palette.js"
import type { SessionFacts } from "./park.js"
import type { NapProcess } from "./process.js"
import { read } from "./read.js"
import { sanitizeText } from "./text.js"

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * The card for this window, from the live theme and the terminal's current
 * size: the TUI's last frame, dimmed under the nap dialog, or OpenCode's logo
 * when that frame cannot be read or shown. Anything unreadable falls back, so
 * a card never stops a nap.
 */
export function hostCard(context: unknown, proc: NapProcess, session: SessionFacts): string {
  const title = text(session.title)
  try {
    const size = proc.terminalSize()
    const palette = readPalette(read(context, "theme"))
    const frame = captureFrame(read(context, "renderer"), size)
    const fromFrame = frame && frameCard(frame, palette ?? defaultPalette)
    if (fromFrame) return fromFrame
    return napCard({
      size,
      palette,
      title,
      directory: text(session.directory) ?? proc.start.cwd,
      home: proc.home,
      version: text(read(context, "app.version")),
    })
  } catch {
    return plainCard(sanitizeText(title))
  }
}
