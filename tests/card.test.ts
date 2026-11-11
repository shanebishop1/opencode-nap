import { describe, expect, it } from "bun:test"
import { napCard, plainCard, type CardInput } from "../src/card.js"
import { fromInts } from "../src/color.js"
import { defaultPalette, readPalette } from "../src/palette.js"
import { controlCharacters, playCard, withoutSequences } from "./grid.js"
import { fakeTheme } from "./fakes.js"

const input = (width: number, height: number, overrides: Partial<CardInput> = {}): CardInput => ({
  size: { width, height },
  palette: defaultPalette,
  title: "Fix the flaky test",
  directory: "/home/shane/work/app",
  home: "/home/shane",
  version: "2.2.4",
  ...overrides,
})

const screen = (width: number, height: number, overrides: Partial<CardInput> = {}) =>
  playCard(napCard(input(width, height, overrides)), width, height)

const rows = (grid: ReturnType<typeof playCard>) => grid.cells.map((_, row) => grid.text(row))

const MESSAGE = "Napping to save memory. Press any key or click to wake."
const DETAIL = "Sessions keep running in the background."

describe("napCard", () => {
  it("writes exactly these escapes on a small terminal", () => {
    const card = napCard(input(42, 11, { title: "Fix", directory: "/work/app", home: "/home/x" }))
    expect(card).toBe(
      "\x1b[0;48;2;10;10;10m\x1b[2J" +
      "\x1b[5;18H\x1b[0;38;2;128;128;128;48;2;10;10;10m/work/app" +
      "\x1b[7;11HNapping to save memory." +
      "\x1b[8;7HPress any key or click to wake." +
      `\x1b[9;2H${DETAIL}` +
      "\x1b[0m\x1b[?25l",
    )
  })

  describe("layout at 120 by 36", () => {
    const grid = screen(120, 36)

    it("centres the logo four rows tall from row 13", () => {
      expect(rows(grid).slice(12, 16).map(row => row.trimEnd())).toEqual([
        `${" ".repeat(74)}▄`,
        `${" ".repeat(41)}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█`,
        `${" ".repeat(41)}█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀`,
        `${" ".repeat(41)}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀`,
      ])
    })

    it("centres the directory under the logo and the message under it, all muted", () => {
      expect(grid.text(16)).toBe("")
      expect(grid.text(17)).toBe(`${" ".repeat(55)}~/work/app`)
      expect(grid.text(18)).toBe("")
      expect(grid.text(19)).toBe(`${" ".repeat(33)}${MESSAGE}`)
      expect(grid.text(20)).toBe(`${" ".repeat(40)}${DETAIL}`)
      for (const row of [17, 19, 20]) expect(grid.cells[row].find(cell => cell.char !== " ")?.fg).toBe("128,128,128")
    })

    it("shows the version at the bottom right and nothing else", () => {
      expect(grid.text(34)).toBe(`${" ".repeat(113)}2.2.4`)
      expect(rows(grid).filter(Boolean)).toHaveLength(8)
    })

    it("hides the cursor", () => {
      expect(grid.cursorVisible).toBe(false)
    })

    it("keeps the theme's background everywhere that nothing is drawn", () => {
      expect(grid.cells[0][0].bg).toBe("10,10,10")
      expect(grid.cells[35][119].bg).toBe("10,10,10")
    })
  })

  describe("the logo as OpenCode's logo component draws it", () => {
    const grid = screen(120, 36)

    it("draws the left half muted and plain and the right half bold", () => {
      expect(grid.cells[13][41]).toMatchObject({ char: "█", fg: "128,128,128", bold: false })
      expect(grid.cells[13][61]).toMatchObject({ char: "█", fg: "238,238,238", bold: true })
    })

    it("tints the shadow a quarter of the way from the background to each half's colour", () => {
      // 10 + (128 - 10) / 4 = 39.5 and 10 + (238 - 10) / 4 = 67.
      expect(grid.cells[14][42]).toMatchObject({ char: " ", bg: "40,40,40" })
      expect(grid.cells[14][62]).toMatchObject({ char: " ", bg: "67,67,67", bold: true })
      // `^` is a half block in the text colour on the shadow.
      expect(grid.cells[14][77]).toMatchObject({ char: "▀", fg: "238,238,238", bg: "67,67,67" })
      // `~` is a half block in the shadow colour on the plain background.
      expect(grid.cells[15][57]).toMatchObject({ char: "▀", fg: "40,40,40", bg: "10,10,10" })
    })
  })

  describe("breakpoints", () => {
    const logoOf = (grid: ReturnType<typeof playCard>, count: number) => {
      const lines = rows(grid)
      return lines.slice(lines.findIndex(row => /[█▄]/.test(row)), lines.length).slice(0, count).map(row => row.trim())
    }

    it("shows no logo below 12 rows", () => {
      expect(rows(screen(80, 11)).join("")).not.toContain("█")
      expect(rows(screen(80, 12)).join("")).toContain("█")
    })

    it("stacks the halves and splits the message below 44 columns", () => {
      const grid = screen(43, 24)
      expect(logoOf(grid, 7)).toEqual([
        "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█  █ █  █ █▀▀▀ █  █", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀",
        "▄", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█    █  █ █  █ █▀▀▀", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
      ])
      expect(rows(grid).map(row => row.trim())).toEqual(expect.arrayContaining(["Napping to save memory.", "Press any key or click to wake.", DETAIL]))
    })

    it("shows the version only from 64 columns and 14 rows", () => {
      expect(rows(screen(64, 24)).join("\n")).toContain("2.2.4")
      expect(rows(screen(63, 24)).join("\n")).not.toContain("2.2.4")
      expect(rows(screen(120, 13)).join("\n")).not.toContain("2.2.4")
    })

    it("centres what fits and gives up below five rows", () => {
      expect(rows(screen(80, 12)).findIndex(row => row.includes("▄"))).toBe(2)
      expect(rows(screen(80, 5)).findIndex(row => row.includes("~/work/app"))).toBe(1)
      expect(napCard(input(80, 4))).toBe(plainCard("Fix the flaky test"))
    })
  })

  describe("theme", () => {
    it("takes its colours from the live theme tokens", () => {
      const theme = { ...fakeTheme(), background: { base: fromInts(20, 30, 40) } }
      const grid = screen(120, 36, { palette: readPalette(theme) })
      expect(grid.cells[0][0].bg).toBe("20,30,40")
      // 20 + (128 - 20) / 4 = 47.
      expect(grid.cells[14][42].bg).toBe("47,55,62")
    })

    it("leaves the terminal's own background alone when the theme's is transparent", () => {
      const transparent = { ...defaultPalette.background, a: 0 }
      const card = napCard(input(120, 36, { palette: { ...defaultPalette, background: transparent } }))
      expect(card.startsWith("\x1b[0m\x1b[2J")).toBe(true)
      expect(playCard(card, 120, 36).cells[0][0].bg).toBeUndefined()
    })
  })

  describe("untrusted text", () => {
    it("sends no control character or sequence of the directory or version", () => {
      const hostile = `a${"\x1b"}[2J${"\x1b"}]0;owned\x07\r\nb\x9b\x00`
      const card = napCard(input(120, 36, { directory: `/tmp/${hostile}`, version: hostile }))
      expect(controlCharacters(withoutSequences(card))).toEqual([])
      expect(withoutSequences(card)).toContain("a [2J ]0;owned b")
    })

    it("cuts a long directory to the screen, keeping its end", () => {
      const location = rows(screen(100, 36, { directory: `/${"d".repeat(200)}/app` })).find(row => row.includes("app")) ?? ""
      expect(location.trim().startsWith("…/app")).toBe(true)
      expect(location.length).toBeLessThanOrEqual(98)
    })

    it("shows nothing for a missing directory or version", () => {
      const grid = screen(120, 36, { directory: undefined, version: undefined })
      expect(grid.text(17)).toBe("")
      expect(grid.text(19)).toContain(MESSAGE)
      expect(grid.text(34)).toBe("")
    })
  })

  describe("fallback", () => {
    it("prints the plain text when the size is unknown or too small", () => {
      expect(napCard(input(120, 36, { size: undefined }))).toBe(plainCard("Fix the flaky test"))
      expect(napCard(input(41, 36))).toBe(plainCard("Fix the flaky test"))
      expect(napCard(input(80, 4))).toBe(plainCard("Fix the flaky test"))
    })

    it("uses OpenCode's default theme when no palette could be read", () => {
      expect(napCard(input(80, 24, { palette: undefined }))).toBe(napCard(input(80, 24)))
    })
  })
})

describe("plainCard", () => {
  it("is the title on its own line above the message", () => {
    expect(plainCard("Fix the flaky test")).toBe(`Fix the flaky test\r\n${MESSAGE}\r\n`)
    expect(plainCard("")).toBe(`${MESSAGE}\r\n`)
  })
})
