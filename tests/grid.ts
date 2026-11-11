export interface Cell {
  char: string
  fg: string | undefined
  bg: string | undefined
  bold: boolean
}

export interface Grid {
  cells: Cell[][]
  cursor: { row: number; col: number }
  cursorVisible: boolean
  /** The characters of a row, trailing spaces trimmed. */
  text(row: number): string
}

const ESC = "\x1b"
// Either an escape sequence the card writes (CSI, parameters, final letter) or plain text.
const TOKEN = new RegExp(`${ESC}\\[(\\??[0-9;]*)([A-Za-z])|([^${ESC}]+)`, "g")

const SEQUENCE = new RegExp(`${ESC}\\[\\??[0-9;]*[A-Za-z]`, "g")

/** The card with its CSI sequences removed. */
export const withoutSequences = (card: string): string => card.replace(SEQUENCE, "")

/** The C0, DEL and C1 characters in the text. */
export const controlCharacters = (text: string): string[] =>
  [...text].filter(char => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f)
  })

const blank = (): Cell => ({ char: " ", fg: undefined, bg: undefined, bold: false })

// Applies a truecolor SGR sequence's parameters; only the forms the card writes.
function applyStyle(style: Omit<Cell, "char">, parameters: string): void {
  const codes = parameters.split(";").map(Number)
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]
    if (code === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false })
    else if (code === 1) style.bold = true
    else if (code === 38 || code === 48) {
      const color = codes.slice(index + 2, index + 5).join(",")
      if (code === 38) style.fg = color
      else style.bg = color
      index += 4
    } else throw new Error(`unexpected SGR code ${code}`)
  }
}

/** Plays a card onto a width by height screen the way a terminal would, for the sequences the card uses. */
export function playCard(card: string, width: number, height: number): Grid {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, blank))
  const style = { fg: undefined as string | undefined, bg: undefined as string | undefined, bold: false }
  const cursor = { row: 0, col: 0 }
  let cursorVisible = true
  for (const [, parameters, final, text] of card.matchAll(TOKEN)) {
    if (text !== undefined) {
      for (const char of text) cells[cursor.row][cursor.col++] = { char, ...style }
    } else if (final === "m") applyStyle(style, parameters)
    else if (final === "H") {
      const [row, col] = parameters.split(";").map(Number)
      Object.assign(cursor, { row: row - 1, col: col - 1 })
    } else if (final === "J" && parameters === "2") {
      for (const row of cells) row.fill({ char: " ", fg: style.fg, bg: style.bg, bold: false })
    } else if (parameters === "?25" && (final === "l" || final === "h")) cursorVisible = final === "h"
    else throw new Error(`unexpected sequence ${JSON.stringify(parameters + final)}`)
  }
  return { cells, cursor, cursorVisible, text: row => cells[row].map(cell => cell.char).join("").trimEnd() }
}
