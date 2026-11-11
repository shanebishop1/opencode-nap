import { footerRows, locationPlacements, versionPlacements } from "./card-footer.js"
import { lineWidth, logoLines } from "./card-logo.js"
import { boxWidth, promptPlacements, PROMPT_ROWS, type PromptBox } from "./card-prompt.js"
import { defaultPalette, type Palette } from "./palette.js"
import { paint, type Placement } from "./screen.js"
import { sanitizeText, takeWidth } from "./text.js"

export interface CardInput {
  size: { width: number; height: number } | undefined
  /** The live theme's colours, or undefined for OpenCode's default theme. */
  palette: Palette | undefined
  title: string | undefined
  directory: string | undefined
  home: string
  version: string | undefined
}

// Home's fixed gap above the logo, which shrinks first on a short terminal.
const TOP_SPACER = 3
const MIN_WIDTH = 20
const MAX_VERSION_WIDTH = 16

/** Where Yoga puts a child of `inner` cells centred in a column that starts at `start`. */
const centered = (start: number, outer: number, inner: number): number => Math.round(start + (outer - inner) / 2)

/** What a terminal too small for the home screen shows. */
export const plainCard = (title: string): string =>
  `${title ? `${title}\r\n` : ""}Napping to save memory. Press any key or click to wake.\r\n`

// OpenCode's home screen with the nap message in place of the prompt. The
// column is laid out as home.tsx does: a spacer that grows, a fixed spacer
// above the logo, the logo, a blank row and the prompt, then a spacer that grows.
function homeCard(input: CardInput, title: string, palette: Palette): string | undefined {
  if (!input.size || input.size.width < MIN_WIDTH) return undefined
  const { width, height } = input.size
  const inset = width < 44 ? 1 : 2
  const contentWidth = width - 2 * inset
  const logo = logoLines(width, height, palette)
  const logoRows = logo.length ? logo.length + 1 : 0
  const free = height - footerRows(width, height) - TOP_SPACER - logoRows - PROMPT_ROWS
  if (free < -TOP_SPACER) return undefined
  const logoTop = Math.max(0, Math.round(free / 2)) + Math.min(TOP_SPACER, TOP_SPACER + free)

  const logoCol = centered(inset, contentWidth, Math.max(0, ...logo.map(lineWidth)))
  const box: PromptBox = {
    row: logoTop + logoRows,
    width: boxWidth(contentWidth),
    col: centered(inset, contentWidth, boxWidth(contentWidth)),
    inset,
  }
  const placements: Placement[] = [
    ...logo.map((spans, index) => ({ row: logoTop + index, col: logoCol, spans })),
    ...promptPlacements(box, title, palette),
    ...locationPlacements(box, width, sanitizeText(input.directory), input.home, palette),
    ...versionPlacements(width, height, takeWidth(sanitizeText(input.version), MAX_VERSION_WIDTH), palette),
  ]
  // The cursor rests where OpenCode's prompt would put it.
  return paint(placements, palette.background, { row: box.row + 2, col: box.col + 1 + inset })
}

/** The nap screen as one string for the stub to print, built from the terminal size and theme at nap time. */
export function napCard(input: CardInput): string {
  const title = sanitizeText(input.title)
  return homeCard(input, title, input.palette ?? defaultPalette) ?? plainCard(title)
}
