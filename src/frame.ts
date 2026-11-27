import { readColor, type Color } from "./color.js"
import { isObject, read } from "./read.js"

/** A run of cells in one style, as OpenTUI's renderer last drew it. */
export interface FrameSpan {
  text: string
  /** Cells it covers, which can differ from its character count (wide and combined characters). */
  width: number
  fg: Color
  bg: Color
  bold: boolean
}

/** The screen as rows of spans, each row exactly the terminal's width. */
export type Frame = FrameSpan[][]

// OpenTUI's TextAttributes.BOLD.
const BOLD = 1

function readSpan(span: unknown): FrameSpan | undefined {
  if (!isObject(span)) return undefined
  const { text, width, attributes } = span
  const fg = readColor(span.fg)
  const bg = readColor(span.bg)
  if (typeof text !== "string" || !Number.isInteger(width) || (width as number) < 0 || !fg || !bg) return undefined
  return { text, width: width as number, fg, bg, bold: typeof attributes === "number" && (attributes & BOLD) !== 0 }
}

/**
 * Reads the frame the renderer last drew. Undefined when the renderer has no
 * readable frame or it is not the terminal's size, so a stale or partial frame
 * is never shown.
 */
export function captureFrame(renderer: unknown, size: { width: number; height: number } | undefined): Frame | undefined {
  try {
    const buffer = read(renderer, "currentRenderBuffer")
    if (!size || !isObject(buffer) || typeof buffer.getSpanLines !== "function") return undefined
    if (buffer.width !== size.width || buffer.height !== size.height) return undefined
    const lines: unknown = buffer.getSpanLines()
    if (!Array.isArray(lines) || lines.length !== size.height) return undefined
    const frame: Frame = []
    for (const line of lines) {
      const spans = isObject(line) && Array.isArray(line.spans) ? line.spans.map(readSpan) : [undefined]
      if (spans.some(span => !span)) return undefined
      const row = spans as FrameSpan[]
      if (row.reduce((sum, span) => sum + span.width, 0) !== size.width) return undefined
      frame.push(row)
    }
    return frame
  } catch {
    return undefined
  }
}
