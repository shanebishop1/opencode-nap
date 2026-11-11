import { tint, type Color } from "./color.js"
import { logo } from "./logo.js"
import type { Palette } from "./palette.js"
import type { Span } from "./screen.js"
import { textWidth } from "./text.js"

// Mirrors anomalyco/opencode packages/tui/src/component/logo.tsx (MIT), tag
// v2.2.4: one span per character, which paint() merges where the style repeats.
function lineSpans(line: string, fg: Color, bold: boolean, palette: Palette): Span[] {
  const shadow = tint(palette.background, fg, 0.25)
  return Array.from(line).map((char): Span => {
    switch (char) {
      case "_": return { text: " ", style: { fg, bg: shadow, bold } }
      case "^": return { text: "▀", style: { fg, bg: shadow, bold } }
      case "~": return { text: "▀", style: { fg: shadow, bold } }
      case ",": return { text: "▄", style: { fg: shadow, bold } }
      default: return { text: char, style: { fg, bold } }
    }
  })
}

/** The logo's lines for a terminal size: none when short, stacked when narrow. */
export function logoLines(width: number, height: number, palette: Palette): Span[][] {
  const { text, muted } = palette
  if (height < 12) return []
  if (width < 44) {
    return [
      ...logo.left.slice(1).map(line => lineSpans(line, muted, false, palette)),
      ...logo.right.map(line => lineSpans(line, text, true, palette)),
    ]
  }
  return logo.left.map((left, index) => [
    ...lineSpans(left, muted, false, palette),
    { text: " " },
    ...lineSpans(logo.right[index], text, true, palette),
  ])
}

export const lineWidth = (line: Span[]): number => textWidth(line.map(span => span.text).join(""))
