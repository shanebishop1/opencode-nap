import { fromInts, readColor, tint, type Color } from "./color.js"
import { read } from "./read.js"

/** The theme colours the nap card uses. */
export interface Palette {
  background: Color
  text: Color
  muted: Color
}

// OpenCode's default dark theme, used when the live theme cannot be read.
export const defaultPalette: Palette = {
  background: fromInts(10, 10, 10),
  text: fromInts(238, 238, 238),
  muted: fromInts(128, 128, 128),
}

// A translucent text colour shows the background through it; the terminal
// only takes solid colours, so blend it the way OpenCode's renderer does.
const over = (background: Color, color: Color): Color => (color.a < 1 ? tint(background, color, color.a) : color)

/**
 * Reads the palette from OpenCode's theme tokens. Undefined when any token is
 * missing, so a card never mixes theme and default colours.
 */
export function readPalette(theme: unknown): Palette | undefined {
  try {
    const background = readColor(read(theme, "background.base"))
    const text = readColor(read(theme, "text.base"))
    const muted = readColor(read(theme, "text.muted"))
    if (!background || !text || !muted) return undefined
    return { background, text: over(background, text), muted: over(background, muted) }
  } catch {
    return undefined
  }
}
