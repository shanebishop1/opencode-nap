import { describe, expect, it } from "bun:test"
import { createFocusSource } from "../src/focus.js"
import { FakeEmitter } from "./fakes.js"

describe("createFocusSource", () => {
  it("reports unknown until the first event, then tracks focus and when it was lost", () => {
    let now = 1_000
    const renderer = new FakeEmitter()
    const focus = createFocusSource({ renderer, now: () => now })
    expect(focus.state()).toEqual({ focus: "unknown", unfocusedSince: undefined })

    renderer.emit("blur")
    expect(focus.state()).toEqual({ focus: "unfocused", unfocusedSince: 1_000 })
    now = 5_000
    renderer.emit("blur")
    expect(focus.state()).toEqual({ focus: "unfocused", unfocusedSince: 1_000 })

    renderer.emit("focus")
    expect(focus.state()).toEqual({ focus: "focused", unfocusedSince: undefined })
    now = 9_000
    renderer.emit("blur")
    expect(focus.state()).toEqual({ focus: "unfocused", unfocusedSince: 9_000 })
  })

  it("starts focused on a focus event and dispose removes its listeners", () => {
    const renderer = new FakeEmitter()
    const focus = createFocusSource({ renderer, now: () => 0 })
    renderer.emit("focus")
    expect(focus.state().focus).toBe("focused")
    expect(renderer.count()).toBe(2)
    focus.dispose()
    expect(renderer.count()).toBe(0)
  })
})
