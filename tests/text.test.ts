import { describe, expect, it } from "bun:test"
import { sanitizeText, takeWidth, textWidth } from "../src/text.js"

const ESC = "\x1b"

describe("sanitizeText", () => {
  it("replaces control characters, ESC and C1 with spaces", () => {
    expect(sanitizeText(`a${ESC}[31mred\x07\x00\tb\nc\x9bd\x7f`)).toBe("a [31mred b c d")
    expect(sanitizeText(`${ESC}]0;x\x07`)).toBe("]0;x")
    expect(sanitizeText("plain title")).toBe("plain title")
    expect(sanitizeText(undefined)).toBe("")
  })
})

describe("textWidth", () => {
  it("counts wide characters twice and combining marks not at all", () => {
    expect(textWidth("abc")).toBe(3)
    expect(textWidth("日本語")).toBe(6)
    expect(textWidth("🙂")).toBe(2)
    expect(textWidth("é")).toBe(1)
    expect(textWidth("…")).toBe(1)
  })
})

describe("takeWidth", () => {
  it("keeps text that fits and ends a cut with an ellipsis within the width", () => {
    expect(takeWidth("short", 5)).toBe("short")
    expect(takeWidth("a longer title", 8)).toBe("a longe…")
    expect(takeWidth("日本語のタイトル", 7)).toBe("日本語…")
    expect(takeWidth("trailing space ok", 9)).toBe("trailing…")
  })

  it("returns nothing when there is no room", () => {
    expect(takeWidth("title", 0)).toBe("")
    expect(takeWidth("title", -3)).toBe("")
  })
})
