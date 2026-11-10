import { describe, expect, it } from "bun:test"
import { decide, type Focus, type PolicyInput } from "../src/policy.js"

const MINUTE = 60_000
const options = { idleMinutes: 15, napOnBlur: false, blurIdleMinutes: undefined }

const start: PolicyInput = {
  now: 1_000_000,
  lastInputAt: 1_000_000,
  focus: "focused",
  unfocusedSince: undefined,
  deferReasons: [],
}

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return { ...start, ...overrides }
}

describe("decide (idle rule)", () => {
  it("waits while the session has not been idle long enough", () => {
    expect(decide(input({ now: start.lastInputAt + 14 * MINUTE }), options)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("naps exactly at the idle threshold", () => {
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE }), options)).toEqual({ action: "nap", rule: "idle" })
  })

  it("waits one millisecond before the threshold", () => {
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE - 1 }), options)).toEqual({
      action: "wait",
      checkAfterMs: 1_000,
      deferred: [],
    })
  })

  it("ac-input-resets: input moved forward restarts the idle clock", () => {
    const now = start.lastInputAt + 15 * MINUTE
    expect(decide(input({ now }), options)).toEqual({ action: "nap", rule: "idle" })

    expect(decide(input({ now, lastInputAt: now - MINUTE }), options)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("reports deferral reasons instead of napping when a nap is unsafe", () => {
    const deferReasons = ["draft unreadable", "wake command line refused"]
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE, deferReasons }), options)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: ["draft unreadable", "wake command line refused"],
    })
  })

  it("reports no deferred reasons when no nap was due", () => {
    expect(
      decide(input({ now: start.lastInputAt + 14 * MINUTE, deferReasons: ["draft unreadable"] }), options),
    ).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })
  })

  it("clamps the next check to between one and five seconds", () => {
    const far = decide(input({ now: start.lastInputAt + 1 * MINUTE }), options)
    expect(far).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

    const near = decide(input({ now: start.lastInputAt + 15 * MINUTE - 3_000 }), options)
    expect(near).toEqual({ action: "wait", checkAfterMs: 3_000, deferred: [] })

    const tiny = decide(input({ now: start.lastInputAt + 15 * MINUTE - 1 }), options)
    expect(tiny).toEqual({ action: "wait", checkAfterMs: 1_000, deferred: [] })
  })

  it("handles fractional idle minutes", () => {
    const short = { ...options, idleMinutes: 0.25 }
    expect(decide(input({ now: start.lastInputAt + 10_000 }), short)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
    expect(decide(input({ now: start.lastInputAt + 14_000 }), short)).toEqual({
      action: "wait",
      checkAfterMs: 1_000,
      deferred: [],
    })
    expect(decide(input({ now: start.lastInputAt + 15_000 }), short)).toEqual({ action: "nap", rule: "idle" })
  })

  it("counts input from the future as zero idle time", () => {
    const short = { ...options, idleMinutes: 0.25 }
    expect(decide(input({ now: start.now, lastInputAt: start.now + MINUTE }), short)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("ignores focus until the blur rules land", () => {
    const blurOptions = { idleMinutes: 15, napOnBlur: true, blurIdleMinutes: 1 }
    const focuses: Focus[] = ["focused", "unfocused", "unknown"]
    const unfocusedSince = start.now - 60 * MINUTE

    for (const focus of focuses) {
      const notIdle = input({ focus, unfocusedSince, now: start.lastInputAt + 14 * MINUTE })
      expect(decide(notIdle, blurOptions)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

      const idle = input({ focus, unfocusedSince, now: start.lastInputAt + 15 * MINUTE })
      expect(decide(idle, blurOptions)).toEqual({ action: "nap", rule: "idle" })
    }
  })
})
