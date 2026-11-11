import { abbreviateHome, truncatePath } from "./path.js"
import type { Palette } from "./palette.js"
import type { Placement } from "./screen.js"
import { textWidth } from "./text.js"
import type { PromptBox } from "./card-prompt.js"

const HINT = { key: "any key", action: " wake" }
const HINT_WIDTH = textWidth(HINT.key + HINT.action)

const showsVersion = (width: number) => width >= 64
const showsHint = (width: number) => width >= 44

/**
 * Rows the home footer takes at the bottom: none on a small terminal, and its
 * padding and version line otherwise, each only where they fit.
 */
export function footerRows(width: number, height: number): number {
  if (width < 44 || height < 14) return 0
  return (height < 16 ? 0 : 2) + (showsVersion(width) ? 1 : 0)
}

/** The line under the prompt box: the working directory, and the wake hint where OpenCode lists its shortcuts. */
export function locationPlacements(box: PromptBox, width: number, directory: string, home: string, palette: Palette): Placement[] {
  const row = box.row + 6
  const hint = showsHint(width)
  const room = box.width - (hint ? HINT_WIDTH + 2 : 0)
  const shown = truncatePath(abbreviateHome(directory, home), room)
  return [
    ...(shown ? [{ row, col: box.col, spans: [{ text: shown, style: { fg: palette.muted } }] }] : []),
    ...(hint
      ? [{
        row,
        col: box.col + box.width - HINT_WIDTH,
        spans: [{ text: HINT.key, style: { fg: palette.text } }, { text: HINT.action, style: { fg: palette.muted } }],
      }]
      : []),
  ]
}

/** The version at the bottom right, where OpenCode's home footer shows it. */
export function versionPlacements(width: number, height: number, version: string, palette: Palette): Placement[] {
  if (!footerRows(width, height) || !showsVersion(width) || !version) return []
  const row = height < 16 ? height - 1 : height - 2
  return [{ row, col: width - 2 - textWidth(version), spans: [{ text: version, style: { fg: palette.muted } }] }]
}
