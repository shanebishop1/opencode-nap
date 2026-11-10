import { describe, expect, it } from "bun:test"
import { decide, type Decision, type Focus, type PolicyInput } from "../src/policy.js"

const MINUTE = 60_000
const options = { idleMinutes: 15, napOnBlur: false, blurIdleMinutes: undefined }
const blurOn = { ...options, napOnBlur: true }
const blurIdleOn = { ...options, blurIdleMinutes: 5 }
const bothOn = { idleMinutes: 15, napOnBlur: true, blurIdleMinutes: 5 }

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

/** Unfocused since `start.now`, `ms` later. */
const unfocusedFor = (ms: number, overrides: Partial<PolicyInput> = {}) =>
  input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + ms, ...overrides })

const wait = (checkAfterMs: number, deferred: string[] = []): Decision => ({ action: "wait", checkAfterMs, deferred })
const nap = (rule: "idle" | "blurIdle" | "blur"): Decision => ({ action: "nap", rule })

describe("decide (idle rule)", () => {
  it("waits while the session has not been idle long enough", () => {
    expect(decide(input({ now: start.lastInputAt + 14 * MINUTE }), options)).toEqual(wait(5_000))
  })

  it("naps exactly at the idle threshold", () => {
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE }), options)).toEqual(nap("idle"))
  })

  it("ac-input-resets: input moved forward restarts the idle clock", () => {
    const now = start.lastInputAt + 15 * MINUTE
    expect(decide(input({ now }), options)).toEqual(nap("idle"))
    expect(decide(input({ now, lastInputAt: now - MINUTE }), options)).toEqual(wait(5_000))
  })

  it("reports deferral reasons instead of napping when a nap is unsafe", () => {
    const deferReasons = ["draft unreadable", "wake command line refused"]
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE, deferReasons }), options)).toEqual(wait(5_000, deferReasons))
  })

  it("reports no deferred reasons when no nap was due", () => {
    expect(decide(input({ now: start.lastInputAt + 14 * MINUTE, deferReasons: ["draft unreadable"] }), options)).toEqual(wait(5_000))
  })

  it("clamps the next check to between a quarter second and five seconds", () => {
    expect(decide(input({ now: start.lastInputAt + 1 * MINUTE }), options)).toEqual(wait(5_000))
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE - 3_000 }), options)).toEqual(wait(3_000))
    expect(decide(input({ now: start.lastInputAt + 15 * MINUTE - 1 }), options)).toEqual(wait(250))
  })

  it("handles fractional idle minutes", () => {
    const short = { ...options, idleMinutes: 0.25 }
    expect(decide(input({ now: start.lastInputAt + 10_000 }), short)).toEqual(wait(5_000))
    expect(decide(input({ now: start.lastInputAt + 14_000 }), short)).toEqual(wait(1_000))
    expect(decide(input({ now: start.lastInputAt + 15_000 }), short)).toEqual(nap("idle"))
  })

  it("counts input from the future as zero idle time", () => {
    const short = { ...options, idleMinutes: 0.25 }
    expect(decide(input({ now: start.now, lastInputAt: start.now + MINUTE }), short)).toEqual(wait(5_000))
  })
})

describe("decide (blur rule)", () => {
  it("ac-nap-on-blur: naps once the window has been unfocused for 2 seconds", () => {
    expect(decide(unfocusedFor(2_000), blurOn)).toEqual(nap("blur"))
  })

  it("ac-blur-debounce: waits for the rest of the debounce while unfocused for less than 2 seconds", () => {
    expect(decide(unfocusedFor(1_000), blurOn)).toEqual(wait(1_000))
    expect(decide(unfocusedFor(1_500), blurOn)).toEqual(wait(500))
    expect(decide(unfocusedFor(1_999), blurOn)).toEqual(wait(250))
  })

  it("ac-blur-debounce: refocusing inside the debounce cancels the blur", () => {
    expect(decide(input({ now: start.now + 1_999 }), blurOn)).toEqual(wait(5_000))
  })

  it("waits when the unfocused start time is unknown", () => {
    expect(decide(unfocusedFor(10_000, { unfocusedSince: undefined }), blurOn)).toEqual(wait(5_000))
  })

  it("does not nap on blur when napOnBlur is off", () => {
    expect(decide(unfocusedFor(10_000), options)).toEqual(wait(5_000))
  })
})

describe("decide (blurIdle rule)", () => {
  it("ac-blur-idle: naps an unfocused window once idle reaches blurIdleMinutes", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE }), blurIdleOn)).toEqual(nap("blurIdle"))
  })

  it("ac-blur-idle: checks again when blurIdleMinutes is next due", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE - 3_000 }), blurIdleOn)).toEqual(wait(3_000))
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE - 1 }), blurIdleOn)).toEqual(wait(250))
  })

  it("ac-blur-idle: a focused window with the same idle time keeps waiting", () => {
    expect(decide(input({ focus: "focused", now: start.lastInputAt + 5 * MINUTE }), blurIdleOn)).toEqual(wait(5_000))
  })
})

describe("decide (focus rules)", () => {
  it("reports deferral reasons instead of napping on either focus rule", () => {
    const deferReasons = ["draft unreadable"]
    expect(decide(unfocusedFor(2_000, { deferReasons }), blurOn)).toEqual(wait(5_000, deferReasons))
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE, deferReasons }), blurIdleOn))
      .toEqual(wait(5_000, deferReasons))
  })

  it("ac-focus-unknown: unknown focus ignores the focus rules and only the idle rule applies", () => {
    const unknown = (now: number) => input({ focus: "unknown", unfocusedSince: start.now, now })
    expect(decide(unknown(start.now + 5 * MINUTE), bothOn)).toEqual(wait(5_000))
    expect(decide(unknown(start.lastInputAt + 15 * MINUTE), bothOn)).toEqual(nap("idle"))
  })

  it("a focused window ignores the focus rules", () => {
    const focused = (now: number) => input({ focus: "focused", unfocusedSince: start.now, now })
    expect(decide(focused(start.now + 10_000), bothOn)).toEqual(wait(5_000))
    expect(decide(focused(start.lastInputAt + 15 * MINUTE), bothOn)).toEqual(nap("idle"))
  })

  it("ac-focus-defaults: with default options every focus state decides the same way", () => {
    const focuses: Focus[] = ["focused", "unfocused", "unknown"]
    const unfocusedSince = start.now - 60 * MINUTE
    for (const focus of focuses) {
      expect(decide(input({ focus, unfocusedSince, now: start.lastInputAt + 5 * MINUTE }), options)).toEqual(wait(5_000))
      expect(decide(input({ focus, unfocusedSince, now: start.lastInputAt + 15 * MINUTE }), options)).toEqual(nap("idle"))
    }
  })
})

describe("decide (rule precedence)", () => {
  it("reports idle first when idle, blurIdle and blur are all due", () => {
    expect(decide(unfocusedFor(15 * MINUTE), bothOn)).toEqual(nap("idle"))
  })

  it("reports blurIdle before blur when both are due", () => {
    expect(decide(unfocusedFor(5 * MINUTE), bothOn)).toEqual(nap("blurIdle"))
  })

  it("reports blur when only the blur debounce is due", () => {
    expect(decide(unfocusedFor(10_000), bothOn)).toEqual(nap("blur"))
  })
})
