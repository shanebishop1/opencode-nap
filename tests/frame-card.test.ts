import { describe, expect, it } from "bun:test"
import { fromInts, type Color } from "../src/color.js"
import type { Frame, FrameSpan } from "../src/frame.js"
import { DIM, FRAME_CARD_BUDGET, frameCard } from "../src/frame-card.js"
import { defaultPalette } from "../src/palette.js"
import { controlCharacters, playCard, withoutSequences } from "./grid.js"

const base = defaultPalette.background
const fg = fromInts(210, 210, 210)
const panel = fromInts(110, 60, 10)

const span = (text: string, overrides: Partial<FrameSpan> = {}): FrameSpan =>
  ({ text, width: text.length, fg, bg: base, bold: false, ...overrides })

/** A frame of blank rows on the theme background, with `rows` written over the top. */
function frameOf(width: number, height: number, rows: FrameSpan[][] = []): Frame {
  return Array.from({ length: height }, (_, index) => {
    const row = rows[index] ?? []
    const used = row.reduce((sum, item) => sum + item.width, 0)
    return used < width ? [...row, span(" ".repeat(width - used))] : row
  })
}

const rgb = (color: Color) => [color.r, color.g, color.b].map(value => Math.round(value * 255)).join(",")
const mix = (from: number, to: number, amount: number) => Math.round(from + (to - from) * amount)

describe("frameCard", () => {
  const frame = frameOf(80, 24, [
    [span("hello world"), span(" "), span("bold", { bold: true })],
    [span("  "), span("panel", { bg: panel }), span("   ")],
  ])
  const card = frameCard(frame, defaultPalette) ?? ""
  const grid = playCard(card, 80, 24)

  it("keeps the frame's text where it was", () => {
    expect(grid.text(0)).toBe("hello world bold")
    expect(grid.text(1)).toBe("  panel")
  })

  it("dims every colour toward the theme's background", () => {
    expect(grid.cells[0][0].fg).toBe([210, 210, 210].map(value => mix(value, 10, DIM.fg)).join(","))
    expect(grid.cells[1][2].bg).toBe([[110, 10], [60, 10], [10, 10]].map(([from, to]) => mix(from, to, DIM.bg)).join(","))
    expect(grid.cells[0][12].bold).toBe(true)
    expect(grid.cells[23][79].bg).toBe(rgb(base))
  })

  it("centres the dialog with the shared nap message", () => {
    const text = grid.cells.map((_, row) => grid.text(row).trim())
    const title = text.indexOf("OpenCode is sleeping")
    expect(title).toBeGreaterThan(0)
    expect(text.slice(title, title + 4)).toEqual([
      "OpenCode is sleeping", "", "Napping to save memory. Press any key or click to wake.", "Sessions keep running in the background.",
    ])
    // Rows 1 to 14 of 24, columns 8 to 70 of 80: the scene, the title and the message.
    expect(grid.cells[1][8].bg).not.toBe(rgb(base))
    expect(grid.cells[14][70].bg).toBe(grid.cells[1][8].bg)
    expect(grid.cells[1][7].bg).toBe(rgb(base))
    expect(grid.cells[0][8].bg).toBe(rgb(base))
    expect(grid.cells[15][8].bg).toBe(rgb(base))
    expect(grid.cursorVisible).toBe(false)
  })

  it("puts the moon above the title, and leaves it out on a short screen", () => {
    const moonRow = "███    ·      ·       z"
    const rowsOf = (height: number) => {
      const shown = playCard(frameCard(frameOf(80, height), defaultPalette) ?? "", 80, height)
      return shown.cells.map((_, row) => shown.text(row).trim())
    }
    const has = (rows: string[]) => rows.findIndex(row => row.includes(moonRow))
    const tall = rowsOf(24)
    expect(has(tall)).toBeGreaterThan(0)
    expect(has(tall)).toBeLessThan(tall.indexOf("OpenCode is sleeping"))
    expect(has(rowsOf(13))).toBe(-1)
    expect(has(rowsOf(14))).toBeGreaterThan(0)
    expect(rowsOf(11)).toContain("OpenCode is sleeping")
  })

  it("splits the message on a narrow screen and gives up when the dialog cannot fit", () => {
    const narrow = playCard(frameCard(frameOf(52, 10), defaultPalette) ?? "", 52, 10)
    const rows = narrow.cells.map((_, row) => narrow.text(row).trim())
    expect(rows).toEqual(expect.arrayContaining(["Napping to save memory.", "Press any key or click to wake."]))
    expect(frameCard(frameOf(51, 10), defaultPalette)).toBeUndefined()
    expect(frameCard(frameOf(80, 5), defaultPalette)).toBeUndefined()
  })

  it("places every span by its cell width, so wide characters shift nothing after them", () => {
    const wide = frameOf(80, 24, [[span("漢字", { width: 4 }), span("x")]])
    const out = frameCard(wide, defaultPalette) ?? ""
    expect(out).toContain("\x1b[1;5H")
  })

  it("sends no control character from the frame's text", () => {
    const hostile = frameOf(80, 24, [[span("a\x1b]0;owned\x07b\x9b")]])
    const out = frameCard(hostile, defaultPalette) ?? ""
    expect(controlCharacters(withoutSequences(out))).toEqual([])
  })

  it("leaves transparent backgrounds to the terminal", () => {
    const clear = { ...base, a: 0 }
    const out = frameCard(frameOf(80, 24, [[span("text", { bg: clear })]]), { ...defaultPalette, background: clear }) ?? ""
    expect(playCard(out, 80, 24).cells[0][0].bg).toBeUndefined()
  })

  it("gives up on a screen over the budget", () => {
    const colour = (index: number) => fromInts(index % 256, (index >> 8) % 256, 7)
    const busy = Array.from({ length: 60 }, (_, row) =>
      Array.from({ length: 300 }, (_, col) => span("x", { fg: colour(row * 300 + col), bg: colour(row * 300 + col + 1) })))
    expect(FRAME_CARD_BUDGET).toBeLessThan(128 * 1024)
    expect(frameCard(busy, defaultPalette)).toBeUndefined()
  })
})
