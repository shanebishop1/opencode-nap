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

  it("ac-input-resets: counts mouse reports split at every byte boundary", () => {
    for (const report of ["\x1b[<35;10;10M", "\x1b[<0;1;1m", "\x1b[32;10;10M", "\x1b[M #!"]) {
      for (let split = 1; split < report.length; split++) {
        const { idle, stdin, tick, setAtime, startedAt } = setup()
        tick(5_000)
        stdin.emit("data", Buffer.from(report.slice(0, split), "latin1"))
        expect(idle.lastInputAt()).toBe(startedAt)
        const completedAt = tick(1_000)
        stdin.emit("data", Buffer.from(report.slice(split), "latin1"))
        setAtime(completedAt)
        expect(idle.lastInputAt()).toBe(completedAt)
      }
    }
  })

  it("ac-focus-not-input: split focus reports and terminal replies still do not reset idle", () => {
    const { idle, stdin, tick, setAtime, startedAt } = setup()
    for (const report of ["\x1b[I", "\x1b[O", "\x1b[?997;1n", "\x1b[?2026;2$y"]) {
      for (const byte of report) {
        setAtime(tick(1_000))
        stdin.emit("data", Buffer.from(byte, "latin1"))
        expect(idle.lastInputAt()).toBe(startedAt)
      }
    }
  })

  it("ac-input-resets: handles bytewise reports without counting a completed report twice", () => {
    for (const report of ["\x1b[<35;10;10M", "\x1b[M #!"]) {
      const { idle, stdin, tick } = setup()
      let completedAt = 0
      for (const byte of report) {
        completedAt = tick(1_000)
        stdin.emit("data", Buffer.from(byte, "latin1"))
      }
      expect(idle.lastInputAt()).toBe(completedAt)
      tick(1_000)
      stdin.emit("data", Buffer.from("\x1b[I"))
      expect(idle.lastInputAt()).toBe(completedAt)
    }
  })

  it("discards oversized unfinished reports and recognises the next mouse report", () => {
    const { idle, stdin, tick, startedAt } = setup()
    tick(1_000)
    stdin.emit("data", `\x1b[<${"1".repeat(100_000)}`)
    tick(1_000)
    stdin.emit("data", ";1;1M")
    expect(idle.lastInputAt()).toBe(startedAt)
    const at = tick(1_000)
    stdin.emit("data", "\x1b[M #!")
    expect(idle.lastInputAt()).toBe(at)
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

  it("ac-focus-not-input, ac-input-resets: handles a long raw stream without a readable access time", () => {
    const { idle, keyInput, stdin, tick, setAtime, startedAt } = setup()
    setAtime(undefined)
    for (let second = 0; second < 120; second++) {
      tick(1_000)
      stdin.emit("data", "\x1b[I")
    }
    expect(idle.lastInputAt()).toBe(startedAt)
    stdin.emit("data", "\x1b[<35;10;")
    const moved = tick(1_000)
    stdin.emit("data", "10M")
    expect(idle.lastInputAt()).toBe(moved)
    tick(1_000)
    stdin.emit("data", "\x1b[O")
    expect(idle.lastInputAt()).toBe(moved)
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
