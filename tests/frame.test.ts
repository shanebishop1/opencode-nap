import { describe, expect, it } from "bun:test"
import { fromInts } from "../src/color.js"
import { captureFrame } from "../src/frame.js"

const white = fromInts(255, 255, 255)
const black = fromInts(0, 0, 0)
const span = (text: string, width = text.length, attributes = 0) => ({ text, width, fg: white, bg: black, attributes })
const renderer = (lines: unknown, width = 4, height = 2) => ({
  currentRenderBuffer: { width, height, getSpanLines: () => lines },
})
const size = { width: 4, height: 2 }

describe("captureFrame", () => {
  it("reads each row's spans with their colours and boldness", () => {
    const frame = captureFrame(renderer([{ spans: [span("ab"), span("cd", 2, 1)] }, { spans: [span("漢 ", 3), span("x")] }]), size)
    const plain = { fg: white, bg: black, bold: false }
    expect(frame).toEqual([
      [{ text: "ab", width: 2, ...plain }, { text: "cd", width: 2, ...plain, bold: true }],
      [{ text: "漢 ", width: 3, ...plain }, { text: "x", width: 1, ...plain }],
    ])
  })

  it("refuses a frame that is not the terminal's size", () => {
    const lines = [{ spans: [span("abcd")] }, { spans: [span("abcd")] }]
    expect(captureFrame(renderer(lines), size)).toBeDefined()
    expect(captureFrame(renderer(lines, 5), size)).toBeUndefined()
    expect(captureFrame(renderer(lines.slice(1), 4, 1), size)).toBeUndefined()
    expect(captureFrame(renderer([{ spans: [span("abc")] }, { spans: [span("abcd")] }]), size)).toBeUndefined()
    expect(captureFrame(renderer(lines), undefined)).toBeUndefined()
  })

  it("refuses anything it cannot read", () => {
    expect(captureFrame({}, size)).toBeUndefined()
    expect(captureFrame(undefined, size)).toBeUndefined()
    expect(captureFrame(renderer([{ spans: [{ text: "abcd", width: 4, fg: "red", bg: black }] }, { spans: [span("abcd")] }]), size)).toBeUndefined()
    const throwing = { currentRenderBuffer: { width: 4, height: 2, getSpanLines: () => { throw new Error("lease") } } }
    expect(captureFrame(throwing, size)).toBeUndefined()
  })
})
