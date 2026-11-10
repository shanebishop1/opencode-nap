import { describe, expect, it } from "bun:test"
import { createIdleSource } from "../src/idle.js"
import { FakeEmitter } from "./fakes.js"

function setup() {
  let now = 1_700_000_000_000
  let atime: number | undefined = now - 30_000
  const keyInput = new FakeEmitter()
  const stdin = new FakeEmitter()
  const idle = createIdleSource({ now: () => now, readAtime: () => atime, keyInput, stdin })
  const startedAt = now
  return {
    idle,
    keyInput,
    stdin,
    startedAt,
    tick(ms: number) {
      now += ms
      return now
    },
    setAtime(value: number | undefined) {
      atime = value
    },
  }
}

describe("createIdleSource", () => {
  it("starts idle from setup, ignoring the access time it found", () => {
    const { idle, startedAt } = setup()
    expect(idle.lastInputAt()).toBe(startedAt)
  })

  it("ac-input-resets: counts key presses and pastes from the renderer", () => {
    const { idle, keyInput, tick } = setup()
    const pressed = tick(5_000)
    keyInput.emit("keypress", { name: "a" })
    expect(idle.lastInputAt()).toBe(pressed)
    const pasted = tick(5_000)
    keyInput.emit("paste", { bytes: new Uint8Array([120, 121]) })
    expect(idle.lastInputAt()).toBe(pasted)
  })

  it("ac-input-resets: counts SGR, urxvt and X10 mouse reports on the input stream", () => {
    for (const report of ["\x1b[<35;10;10M", "\x1b[<0;1;1m", "\x1b[32;10;10M", "\x1b[M #!"]) {
      const { idle, stdin, tick } = setup()
      const at = tick(5_000)
      stdin.emit("data", Buffer.from(report, "latin1"))
      expect(idle.lastInputAt()).toBe(at)
    }
  })

  it("ac-focus-not-input: ignores focus reports and terminal replies on the input stream", () => {
    const { idle, stdin, tick, startedAt } = setup()
    for (const chunk of ["\x1b[I", "\x1b[O", "\x1b[?997;1n", "\x1b[?2026;2$y"]) {
      tick(1_000)
      stdin.emit("data", Buffer.from(chunk))
    }
    expect(idle.lastInputAt()).toBe(startedAt)
  })

  it("ac-focus-not-input: ignores an access-time bump from a focus report it saw", () => {
    const { idle, stdin, tick, setAtime, startedAt } = setup()
    const at = tick(12_345)
    stdin.emit("data", Buffer.from("\x1b[O"))
    // The kernel stores whole seconds.
    setAtime(Math.floor(at / 1_000) * 1_000)
    tick(3_000)
    expect(idle.lastInputAt()).toBe(startedAt)
  })

  it("counts an access-time bump with no chunk it saw, such as typing into an external editor", () => {
    const { idle, tick, setAtime } = setup()
    const typed = tick(20_000)
    setAtime(typed)
    tick(3_000)
    expect(idle.lastInputAt()).toBe(typed)
  })

  it("never moves the idle time backwards or into the future", () => {
    const { idle, keyInput, tick, setAtime } = setup()
    const pressed = tick(10_000)
    keyInput.emit("keypress", { name: "a" })
    setAtime(pressed - 5_000)
    expect(idle.lastInputAt()).toBe(pressed)
    setAtime(pressed + 60_000)
    const now = tick(1_000)
    expect(idle.lastInputAt()).toBe(now)
  })

  it("tolerates an unreadable access time", () => {
    const { idle, keyInput, tick, setAtime, startedAt } = setup()
    setAtime(undefined)
    expect(idle.lastInputAt()).toBe(startedAt)
    const pressed = tick(1_000)
    keyInput.emit("keypress", { name: "a" })
    expect(idle.lastInputAt()).toBe(pressed)
  })

  it("dispose removes its listeners", () => {
    const { idle, keyInput, stdin } = setup()
    expect(keyInput.count() + stdin.count()).toBe(3)
    idle.dispose()
    expect(keyInput.count() + stdin.count()).toBe(0)
  })
})
