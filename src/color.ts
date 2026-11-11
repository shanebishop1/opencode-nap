/** A colour as OpenCode's theme holds it: channels and alpha as floats from 0 to 1. */
export interface Color {
  r: number
  g: number
  b: number
  a: number
}

export const fromInts = (r: number, g: number, b: number): Color => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 })

/** A channel as the 0 to 255 integer the terminal gets. */
export const channel = (value: number): number => Math.round(value * 255)

/** Mixes `overlay` into `base`, the way OpenCode derives the logo's shadow. */
export function tint(base: Color, overlay: Color, alpha: number): Color {
  const mix = (from: number, to: number) => channel(from + (to - from) * alpha)
  return fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

const isUnit = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1

/** Reads an OpenTUI RGBA, or undefined when the value is not one. */
export function readColor(value: unknown): Color | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { r, g, b, a } = value as Record<string, unknown>
  return isUnit(r) && isUnit(g) && isUnit(b) && isUnit(a) ? { r, g, b, a } : undefined
}
