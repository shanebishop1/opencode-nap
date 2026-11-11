function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

// Turns C0, DEL and C1 characters (including ESC) into spaces, then collapses
// runs of spaces, so text can never send a terminal sequence.
export function sanitizeText(text: string | undefined): string {
  return Array.from(text ?? "", char => isControl(char.codePointAt(0) ?? 0) ? " " : char)
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
}

// Combining marks and format characters such as the zero width joiner.
const ZERO_WIDTH = /^[\p{M}\p{Cf}]$/u
const DOUBLE_WIDTH = /^(?:\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{20000}-\u{3fffd}])$/u

// A cautious count of terminal cells: when unsure it counts too many.
const charWidth = (char: string): number => (ZERO_WIDTH.test(char) ? 0 : DOUBLE_WIDTH.test(char) ? 2 : 1)

export const textWidth = (text: string): number => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0)

/** The start of `text` that fits in `max` cells, ending in an ellipsis when cut. */
export function takeWidth(text: string, max: number): string {
  if (textWidth(text) <= max) return text
  let kept = ""
  for (const char of text) {
    if (textWidth(kept + char) > max - 1) break
    kept += char
  }
  return max < 1 ? "" : `${kept.trimEnd()}…`
}
