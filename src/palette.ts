import { fromInts, readColor, type Color } from "./color.js"
import { read } from "./read.js"

/** The theme colours the nap card uses. */
export interface Palette {
  background: Color
  text: Color
  muted: Color
  /** The prompt box's fill. */
  panel: Color
  /** The prompt box's left bar, which OpenCode colours by agent. */
  accent: Color
}

// OpenCode's default dark theme, used when the live theme cannot be read.
export const defaultPalette: Palette = {
  background: fromInts(10, 10, 10),
  text: fromInts(238, 238, 238),
  muted: fromInts(128, 128, 128),
  panel: fromInts(30, 30, 30),
  accent: fromInts(92, 156, 245),
}

/**
 * Reads the palette from OpenCode's theme tokens, the way its home screen
 * does: the prompt fills with one hue step below the raised background and
 * the first agent takes the first categorical hue. Undefined when any token
 * is missing, so a card never mixes theme and default colours.
 *
 * `decrease` finds a colour's hue step by the token object itself, so it gets
 * the token, not a copy of it.
 */
export function readPalette(theme: unknown): Palette | undefined {
  try {
    const background = readColor(read(theme, "background.base"))
    const decrease = read(theme, "decrease")
    const panel = readColor(typeof decrease === "function" ? decrease.call(theme, read(theme, "background.raised.base")) : undefined)
    const text = readColor(read(theme, "text.base"))
    const muted = readColor(read(theme, "text.muted"))
    const accent = readColor(read(theme, "categorical.0.200"))
    if (!background || !panel || !text || !muted || !accent) return undefined
    // A transparent prompt shows the background through it.
    return { background, text, muted, panel: panel.a === 0 ? background : panel, accent }
  } catch {
    return undefined
  }
}
