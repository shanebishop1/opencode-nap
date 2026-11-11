import { napCard, plainCard } from "./card.js"
import { readPalette } from "./palette.js"
import type { SessionFacts } from "./park.js"
import type { NapProcess } from "./process.js"
import { read } from "./read.js"
import { sanitizeText } from "./text.js"

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * The card for this window, from the live theme and the terminal's current
 * size. Anything unreadable falls back, so a card never stops a nap.
 */
export function hostCard(context: unknown, proc: NapProcess, session: SessionFacts): string {
  const title = text(session.title)
  try {
    return napCard({
      size: proc.terminalSize(),
      palette: readPalette(read(context, "theme")),
      title,
      directory: text(session.directory) ?? proc.start.cwd,
      home: proc.home,
      version: text(read(context, "app.version")),
    })
  } catch {
    return plainCard(sanitizeText(title))
  }
}
