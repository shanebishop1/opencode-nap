import type { Palette } from "./palette.js"
import type { Placement } from "./screen.js"
import { textWidth } from "./text.js"

const showsVersion = (width: number) => width >= 64

/**
 * Rows the home footer takes at the bottom: none on a small terminal, and its
 * padding and version line otherwise, each only where they fit.
 */
export function footerRows(width: number, height: number): number {
  if (width < 44 || height < 14) return 0
  return (height < 16 ? 0 : 2) + (showsVersion(width) ? 1 : 0)
}

/** The version at the bottom right, where OpenCode's home footer shows it. */
export function versionPlacements(width: number, height: number, version: string, palette: Palette): Placement[] {
  if (!footerRows(width, height) || !showsVersion(width) || !version) return []
  const row = height < 16 ? height - 1 : height - 2
  return [{ row, col: width - 2 - textWidth(version), spans: [{ text: version, style: { fg: palette.muted } }] }]
}
