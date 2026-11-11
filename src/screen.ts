import { channel, type Color } from "./color.js"

export interface Style {
  fg?: Color
  bg?: Color
  bold?: boolean
}

export interface Span {
  text: string
  style?: Style
}

/** Spans written from one cell, counted from 0 at the top left. */
export interface Placement {
  row: number
  col: number
  spans: Span[]
}

const ESC = "\x1b"
const truecolor = (code: number, color: Color) => `;${code};2;${channel(color.r)};${channel(color.g)};${channel(color.b)}`

// Every style starts from a reset, so a style never depends on the one before it.
function sgr({ fg, bg, bold }: Style): string {
  return `${ESC}[0${bold ? ";1" : ""}${fg ? truecolor(38, fg) : ""}${bg ? truecolor(48, bg) : ""}m`
}

/**
 * Draws the placements over a cleared screen as one string of truecolor
 * escapes, then leaves the cursor at `cursor`. A solid `background` fills the
 * screen and sits behind every span without a background of its own.
 */
export function paint(placements: Placement[], background: Color | undefined, cursor: { row: number; col: number }): string {
  const fill = background && background.a > 0 ? background : undefined
  const at = (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`
  let current = sgr({ bg: fill })
  let out = `${current}${ESC}[2J`
  for (const { row, col, spans } of placements) {
    out += at(row, col)
    for (const { text, style = {} } of spans) {
      const next = sgr({ bg: fill, ...style })
      if (next !== current) out += next
      current = next
      out += text
    }
  }
  return `${out}${ESC}[0m${at(cursor.row, cursor.col)}`
}
