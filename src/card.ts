import { footerRows, versionPlacements } from "./card-footer.js"
import { lineWidth, logoLines } from "./card-logo.js"
import { defaultPalette, type Palette } from "./palette.js"
import { abbreviateHome, truncatePath } from "./path.js"
import { paint, type Placement } from "./screen.js"
import { sanitizeText, takeWidth, textWidth } from "./text.js"
import type { Color } from "./color.js"

export interface CardInput {
  size: { width: number; height: number } | undefined
  /** The live theme's colours, or undefined for OpenCode's default theme. */
  palette: Palette | undefined
  title: string | undefined
  directory: string | undefined
  home: string
  version: string | undefined
}

// The longest message line and its padding; narrower gets the plain text.
const MIN_WIDTH = 42
const MAX_VERSION_WIDTH = 16
const MESSAGE = ["Napping to save memory.", "Press any key or click to wake."]
const DETAIL = "Sessions keep running in the background."

/** Where Yoga puts a child of `inner` cells centred in a column that starts at `start`. */
const centered = (start: number, outer: number, inner: number): number => Math.round(start + (outer - inner) / 2)

/** What a terminal too small for the home screen shows. */
export const plainCard = (title: string): string => `${title ? `${title}\r\n` : ""}${MESSAGE.join(" ")}\r\n`

// OpenCode's logo, with the directory and the nap message centred below it.
function homeCard(input: CardInput, palette: Palette): string | undefined {
  if (!input.size || input.size.width < MIN_WIDTH) return undefined
  const { width, height } = input.size
  const inset = width < 44 ? 1 : 2
  const contentWidth = width - 2 * inset
  const logo = logoLines(width, height, palette)
  // The message takes one line where it fits and two where it does not.
  const joined = MESSAGE.join(" ")
  const message = textWidth(joined) <= contentWidth ? [joined, DETAIL] : [...MESSAGE, DETAIL]
  // Under the logo: a blank row, the directory, a blank row, then the message.
  const free = height - footerRows(width, height) - logo.length - 3 - message.length
  if (free < 0) return undefined
  const top = Math.round(free / 2)
  const body = top + logo.length
  const line = (row: number, text: string, fg: Color): Placement[] =>
    text ? [{ row, col: centered(inset, contentWidth, textWidth(text)), spans: [{ text, style: { fg } }] }] : []
  const directory = truncatePath(abbreviateHome(sanitizeText(input.directory), input.home), contentWidth)
  const placements: Placement[] = [
    ...logo.map((spans, index) => ({ row: top + index, col: centered(inset, contentWidth, Math.max(...logo.map(lineWidth))), spans })),
    ...line(body + 1, directory, palette.muted),
    ...message.flatMap((text, index) => line(body + 3 + index, takeWidth(text, contentWidth), palette.muted)),
    ...versionPlacements(width, height, takeWidth(sanitizeText(input.version), MAX_VERSION_WIDTH), palette),
  ]
  return paint(placements, palette.background)
}

/** The nap screen as one string for the stub to print, built from the terminal size and theme at nap time. */
export function napCard(input: CardInput): string {
  return homeCard(input, input.palette ?? defaultPalette) ?? plainCard(sanitizeText(input.title))
}
