import type { Palette } from "./palette.js"
import type { Placement, Span } from "./screen.js"
import { takeWidth, textWidth } from "./text.js"

/** Rows from the box's top padding to its location line. */
export const PROMPT_ROWS = 7

const MAX_WIDTH = 75
const PLACEHOLDER = "Napping… press any key or click to wake"
const WORK = "work keeps running"

export interface PromptBox {
  /** Row of the padding above the box. */
  row: number
  col: number
  width: number
  /** Padding inside the box, one narrower on a narrow terminal. */
  inset: number
}

export const boxWidth = (contentWidth: number): number => Math.min(MAX_WIDTH, contentWidth)

// Keeps the spans that fit in `max` cells, cutting the one that crosses it.
function fit(spans: Span[], max: number): Span[] {
  const kept: Span[] = []
  let used = 0
  for (const span of spans) {
    const text = takeWidth(span.text, max - used)
    if (text) kept.push({ ...span, text })
    used += textWidth(text)
    if (text !== span.text) break
  }
  return kept
}

// Styled like OpenCode's agent and model line: the agent, then the model.
function metadata(title: string, palette: Palette, max: number): Span[] {
  const { accent, muted, text } = palette
  return fit([
    { text: "Napping", style: { fg: accent } },
    { text: " · ", style: { fg: muted } },
    ...(title ? [{ text: title, style: { fg: text } }, { text: ` ${WORK}`, style: { fg: muted } }] : [{ text: WORK, style: { fg: text } }]),
  ], max)
}

/** The prompt box as OpenCode's home screen draws it, with the nap message where the prompt text goes. */
export function promptPlacements(box: PromptBox, title: string, palette: Palette): Placement[] {
  const { accent, muted, panel } = palette
  const inner = box.width - 1
  const room = inner - 2 * box.inset
  const textCol = box.col + 1 + box.inset
  const panelRow = (row: number): Placement => ({
    row,
    col: box.col,
    spans: [{ text: "┃", style: { fg: accent } }, { text: " ".repeat(inner), style: { bg: panel } }],
  })
  const overlay = (row: number, spans: Span[]): Placement => ({
    row,
    col: textCol,
    spans: spans.map(span => ({ ...span, style: { ...span.style, bg: panel } })),
  })
  return [
    ...[1, 2, 3, 4].map(offset => panelRow(box.row + offset)),
    overlay(box.row + 2, fit([{ text: PLACEHOLDER, style: { fg: muted } }], room)),
    overlay(box.row + 4, metadata(title, palette, room)),
    {
      row: box.row + 5,
      col: box.col,
      spans: [{ text: "╹", style: { fg: accent } }, { text: "▀".repeat(inner), style: { fg: panel } }],
    },
  ]
}
