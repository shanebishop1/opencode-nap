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

describe("napCard", () => {
  it("writes exactly these escapes on a small terminal", () => {
    const card = napCard(input(21, 13, { title: "Fix", directory: "/work/app", home: "/home/x" }))
    expect(card).toBe(
      "\x1b[0;48;2;10;10;10m\x1b[2J" +
      "\x1b[3;10H\x1b[0;1;38;2;238;238;238;48;2;10;10;10m█▀▀█" +
      "\x1b[4;10H█\x1b[0;1;38;2;238;238;238;48;2;67;67;67m  \x1b[0;1;38;2;238;238;238;48;2;10;10;10m█" +
      "\x1b[5;10H▀▀▀▀" +
      "\x1b[8;2H\x1b[0;38;2;92;156;245;48;2;10;10;10m┃\x1b[0;48;2;30;30;30m" + " ".repeat(18) +
      "\x1b[9;2H\x1b[0;38;2;92;156;245;48;2;10;10;10m┃\x1b[0;48;2;30;30;30m" + " ".repeat(18) +
      "\x1b[10;2H\x1b[0;38;2;92;156;245;48;2;10;10;10m┃\x1b[0;48;2;30;30;30m" + " ".repeat(18) +
      "\x1b[11;2H\x1b[0;38;2;92;156;245;48;2;10;10;10m┃\x1b[0;48;2;30;30;30m" + " ".repeat(18) +
      "\x1b[9;4H\x1b[0;38;2;128;128;128;48;2;30;30;30mNapping… press…" +
      "\x1b[11;4H\x1b[0;38;2;92;156;245;48;2;30;30;30mNapping\x1b[0;38;2;128;128;128;48;2;30;30;30m · " +
      "\x1b[0;38;2;238;238;238;48;2;30;30;30mFix\x1b[0;38;2;128;128;128;48;2;30;30;30m w…" +
      "\x1b[12;2H\x1b[0;38;2;92;156;245;48;2;10;10;10m╹\x1b[0;38;2;30;30;30;48;2;10;10;10m" + "▀".repeat(18) +
      "\x1b[13;2H\x1b[0;38;2;128;128;128;48;2;10;10;10m/work/app" +
      "\x1b[0m\x1b[9;4H",
    )
  })

  describe("layout, measured from OpenCode 2.2.4's home screen at 120 by 36", () => {
    const grid = screen(120, 36)

    it("centres the logo four rows tall from row 13", () => {
      expect(rows(grid).slice(12, 16).map(row => row.trimEnd())).toEqual([
        `${" ".repeat(74)}▄`,
        `${" ".repeat(41)}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█`,
        `${" ".repeat(41)}█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀`,
        `${" ".repeat(41)}▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀`,
      ])
    })

    it("puts the 75 cell prompt box at column 24 with the message at its text position", () => {
      expect(grid.cells[18].slice(23, 25).map(cell => cell.char)).toEqual(["┃", " "])
      expect(grid.cells[18][97].bg).toBe("30,30,30")
      expect(grid.cells[18][98].bg).toBe("10,10,10")
      expect(grid.text(19)).toBe(`${" ".repeat(23)}┃  Napping… press any key or click to wake`)
      expect(grid.text(21)).toBe(`${" ".repeat(23)}┃  Napping · Fix the flaky test work keeps running`)
      expect(grid.text(22)).toBe(`${" ".repeat(23)}╹${"▀".repeat(74)}`)
    })

    it("lists the directory and hint under the box and the version at the bottom right", () => {
      expect(grid.text(23)).toBe(`${" ".repeat(23)}~/work/app${" ".repeat(53)}any key wake`)
      expect(grid.text(34)).toBe(`${" ".repeat(113)}2.2.4`)
    })

    it("rests the cursor where the prompt text starts", () => {
      expect(grid.cursor).toEqual({ row: 19, col: 26 })
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

    it("stacks the halves below 44 columns, the left without its blank first line", () => {
      const grid = screen(43, 24)
      expect(logoOf(grid, 7)).toEqual([
        "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█  █ █  █ █▀▀▀ █  █", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀",
        "▄", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█    █  █ █  █ █▀▀▀", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
      ])
      expect(grid.cells.flat().find(cell => cell.char === "█" && cell.bold)?.fg).toBe("238,238,238")
    })

    it("shows only the small bold logo below 22 columns", () => {
      expect(logoOf(screen(21, 24), 3)).toEqual(["█▀▀█", "█  █", "▀▀▀▀"])
      expect(screen(21, 24).cells.flat().find(cell => cell.char === "█")).toMatchObject({ fg: "238,238,238", bold: true })
    })

    it("narrows the padding and shows the footer only from 44 columns and 14 rows", () => {
      expect(rows(screen(43, 24)).find(row => row.includes("┃"))).toBe(" ┃")
      expect(rows(screen(44, 24)).find(row => row.includes("┃"))).toBe("  ┃")
      expect(rows(screen(44, 24)).join("\n")).toContain("any key wake")
      expect(rows(screen(43, 24)).join("\n")).not.toContain("any key wake")
      expect(rows(screen(120, 13)).join("\n")).not.toContain("2.2.4")
    })

    it("shows the version only from 64 columns", () => {
      expect(rows(screen(64, 24)).join("\n")).toContain("2.2.4")
      expect(rows(screen(63, 24)).join("\n")).not.toContain("2.2.4")
    })

    it("lets the gap above the logo shrink before the card gives up", () => {
      expect(rows(screen(80, 24)).findIndex(row => row.includes("▄"))).toBe(6)
      expect(rows(screen(80, 17)).findIndex(row => row.includes("▄"))).toBe(2)
      expect(rows(screen(80, 13)).findIndex(row => row.includes("▄"))).toBe(1)
      expect(napCard(input(80, 6))).toBe(plainCard("Fix the flaky test"))
    })
  })

  describe("theme", () => {
    it("takes its colours from the live theme tokens", () => {
      const theme = { ...fakeTheme(), background: { ...fakeTheme().background, base: fromInts(20, 30, 40) } }
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
    it("sends no control character or sequence of the title, directory or version", () => {
      const hostile = `a${"\x1b"}[2J${"\x1b"}]0;owned\x07\r\nb\x9b\x00`
      const card = napCard(input(120, 36, { title: hostile, directory: `/tmp/${hostile}`, version: hostile }))
      expect(controlCharacters(withoutSequences(card))).toEqual([])
      expect(withoutSequences(card)).toContain("a [2J ]0;owned b")
    })

    it("cuts a long title and directory to the box", () => {
      const grid = screen(100, 36, { title: "t".repeat(300), directory: `/${"d".repeat(200)}` })
      const message = rows(grid).find(row => row.includes("Napping ·")) ?? ""
      const location = rows(grid).find(row => row.includes("any key wake")) ?? ""
      expect(message.endsWith("…")).toBe(true)
      expect(message.length).toBeLessThanOrEqual(13 + 75)
      expect(location.startsWith(`${" ".repeat(13)}d`)).toBe(true)
      expect(location.length).toBeLessThanOrEqual(13 + 75)
    })

    it("shows nothing for a missing title, directory or version", () => {
      const grid = screen(120, 36, { title: undefined, directory: undefined, version: undefined })
      expect(grid.text(21)).toContain("Napping · work keeps running")
      expect(grid.text(23)).toContain("any key wake")
      expect(grid.text(34)).toBe("")
    })

    it("keeps wide characters inside the box", () => {
      const grid = screen(100, 36, { title: "日本語".repeat(40) })
      const message = rows(grid).find(row => row.includes("Napping ·")) ?? ""
      expect(message.endsWith("…")).toBe(true)
    })
  })

  describe("fallback", () => {
    it("prints the plain text when the size is unknown or too small", () => {
      expect(napCard(input(120, 36, { size: undefined }))).toBe(plainCard("Fix the flaky test"))
      expect(napCard(input(19, 36))).toBe(plainCard("Fix the flaky test"))
      expect(napCard(input(80, 6))).toBe(plainCard("Fix the flaky test"))
    })

    it("uses OpenCode's default theme when no palette could be read", () => {
      expect(napCard(input(80, 24, { palette: undefined }))).toBe(napCard(input(80, 24)))
    })
  })
})

describe("plainCard", () => {
  it("is the title on its own line above the message", () => {
    expect(plainCard("Fix the flaky test")).toBe("Fix the flaky test\r\nNapping to save memory. Press any key or click to wake.\r\n")
    expect(plainCard("")).toBe("Napping to save memory. Press any key or click to wake.\r\n")
  })
})
