import { describe, expect, it } from "bun:test"
import { fromInts, readColor, tint } from "../src/color.js"
import { defaultPalette, readPalette } from "../src/palette.js"
import { fakeTheme } from "./fakes.js"

describe("tint", () => {
  it("mixes a quarter of the overlay in and rounds to whole channels, as OpenCode's shadow does", () => {
    expect(tint(fromInts(10, 10, 10), fromInts(238, 238, 238), 0.25)).toEqual(fromInts(67, 67, 67))
    expect(tint(fromInts(10, 10, 10), fromInts(128, 128, 128), 0.25)).toEqual(fromInts(40, 40, 40))
  })
})

describe("readColor", () => {
  it("reads RGBA floats and refuses anything else", () => {
    expect(readColor({ r: 0, g: 0.5, b: 1, a: 1 })).toEqual({ r: 0, g: 0.5, b: 1, a: 1 })
    expect(readColor({ r: 2, g: 0, b: 0, a: 1 })).toBeUndefined()
    expect(readColor({ r: "1", g: 0, b: 0, a: 1 })).toBeUndefined()
    expect(readColor({ r: 1, g: 0, b: 0 })).toBeUndefined()
    expect(readColor(null)).toBeUndefined()
    expect(readColor("#fff")).toBeUndefined()
  })
})

describe("readPalette", () => {
  it("reads the tokens OpenCode's home screen paints with", () => {
    expect(readPalette(fakeTheme())).toEqual({
      background: fromInts(10, 10, 10),
      text: fromInts(238, 238, 238),
      muted: fromInts(128, 128, 128),
      panel: fromInts(30, 30, 30),
      accent: fromInts(92, 156, 245),
    })
  })

  it("matches the default palette for OpenCode's default dark theme", () => {
    expect(readPalette(fakeTheme())).toEqual(defaultPalette)
  })

  it("lets a transparent prompt show the background through", () => {
    const theme = { ...fakeTheme(), decrease: () => ({ r: 0, g: 0, b: 0, a: 0 }) }
    expect(readPalette(theme)?.panel).toEqual(fromInts(10, 10, 10))
  })

  it("gives up when a token is missing, unreadable or throws", () => {
    expect(readPalette(undefined)).toBeUndefined()
    expect(readPalette({ ...fakeTheme(), text: {} })).toBeUndefined()
    expect(readPalette({ ...fakeTheme(), categorical: [] })).toBeUndefined()
    expect(readPalette({ ...fakeTheme(), decrease: undefined })).toBeUndefined()
    expect(readPalette({ ...fakeTheme(), decrease: () => { throw new Error("no") } })).toBeUndefined()
    expect(readPalette({ ...fakeTheme(), get background(): never { throw new Error("no") } })).toBeUndefined()
  })
})
