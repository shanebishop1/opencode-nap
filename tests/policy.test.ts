import { describe, expect, it } from "bun:test"
import { decide, type Focus, type PolicyInput } from "../src/policy.js"

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
      checkAfterMs: 250,
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

  it("clamps the next check to between a quarter second and five seconds", () => {
    const far = decide(input({ now: start.lastInputAt + 1 * MINUTE }), options)
    expect(far).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

    const near = decide(input({ now: start.lastInputAt + 15 * MINUTE - 3_000 }), options)
    expect(near).toEqual({ action: "wait", checkAfterMs: 3_000, deferred: [] })

    const tiny = decide(input({ now: start.lastInputAt + 15 * MINUTE - 1 }), options)
    expect(tiny).toEqual({ action: "wait", checkAfterMs: 250, deferred: [] })
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
})

describe("decide (blur rule)", () => {
  it("ac-nap-on-blur: naps once the window has been unfocused for 2 seconds", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 2_000 }), blurOn)).toEqual({
      action: "nap",
      rule: "blur",
    })
  })

  it("ac-blur-debounce: waits while the unfocused period is shorter than the debounce", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 1_999 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 250,
      deferred: [],
    })
  })

  it("ac-blur-debounce: refocusing inside the debounce cancels the blur", () => {
    expect(decide(input({ focus: "focused", unfocusedSince: undefined, now: start.now + 1_999 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
    expect(decide(input({ focus: "focused", unfocusedSince: undefined, now: start.now + 5_000 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("waits when the unfocused start time is unknown", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: undefined, now: start.now + 10_000 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("does not nap on blur when napOnBlur is off", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 10_000 }), options)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("checks the debounce promptly when it is the next threshold", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 1_500 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 500,
      deferred: [],
    })
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 1_000 }), blurOn)).toEqual({
      action: "wait",
      checkAfterMs: 1_000,
      deferred: [],
    })
  })

  it("reports deferral reasons instead of napping on blur while work is pending", () => {
    expect(
      decide(
        input({
          focus: "unfocused",
          unfocusedSince: start.now,
          now: start.now + 2_000,
          deferReasons: ["draft is being edited"],
        }),
        blurOn,
      ),
    ).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: ["draft is being edited"] })
  })

  it("reports no deferred reasons while the blur debounce has not elapsed", () => {
    expect(
      decide(
        input({
          focus: "unfocused",
          unfocusedSince: start.now,
          now: start.now + 1_999,
          deferReasons: ["draft is being edited"],
        }),
        blurOn,
      ),
    ).toEqual({ action: "wait", checkAfterMs: 250, deferred: [] })
  })
})

describe("decide (blurIdle rule)", () => {
  it("ac-blur-idle: naps an unfocused window once idle reaches blurIdleMinutes", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE }), blurIdleOn)).toEqual({
      action: "nap",
      rule: "blurIdle",
    })
  })

  it("ac-blur-idle: waits one millisecond before blurIdleMinutes", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE - 1 }), blurIdleOn)).toEqual({
      action: "wait",
      checkAfterMs: 250,
      deferred: [],
    })
  })

  it("ac-blur-idle: a focused window with the same idle time keeps waiting", () => {
    expect(decide(input({ focus: "focused", now: start.lastInputAt + 5 * MINUTE }), blurIdleOn)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
  })

  it("applies whether or not napOnBlur is set", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE }), { ...bothOn, napOnBlur: false })).toEqual(
      { action: "nap", rule: "blurIdle" },
    )
  })

  it("checks the blurIdle threshold promptly when it is the next threshold", () => {
    expect(decide(input({ focus: "unfocused", now: start.lastInputAt + 5 * MINUTE - 3_000 }), blurIdleOn)).toEqual({
      action: "wait",
      checkAfterMs: 3_000,
      deferred: [],
    })
  })

  it("reports deferral reasons instead of napping on blurIdle while work is pending", () => {
    expect(
      decide(
        input({
          focus: "unfocused",
          now: start.lastInputAt + 5 * MINUTE,
          deferReasons: ["stream still running"],
        }),
        blurIdleOn,
      ),
    ).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: ["stream still running"] })
  })
})

describe("decide (focus rules)", () => {
  it("ac-focus-unknown: unknown focus ignores the blur rules and only the idle rule applies", () => {
    const unfocusedSince = start.now
    const unknownNotIdle = input({ focus: "unknown", unfocusedSince, now: start.now + 5 * MINUTE })
    expect(decide(unknownNotIdle, bothOn)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

    const unknownShortly = input({ focus: "unknown", unfocusedSince, now: start.now + 10_000 })
    expect(decide(unknownShortly, bothOn)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

    const unknownIdle = input({ focus: "unknown", unfocusedSince, now: start.lastInputAt + 15 * MINUTE })
    expect(decide(unknownIdle, bothOn)).toEqual({ action: "nap", rule: "idle" })
  })

  it("ac-focus-unknown: a focused window also ignores the blur rules", () => {
    const unfocusedSince = start.now
    expect(decide(input({ focus: "focused", unfocusedSince, now: start.now + 10_000 }), bothOn)).toEqual({
      action: "wait",
      checkAfterMs: 5_000,
      deferred: [],
    })
    expect(decide(input({ focus: "focused", unfocusedSince, now: start.lastInputAt + 15 * MINUTE }), bothOn)).toEqual({
      action: "nap",
      rule: "idle",
    })
  })

  it("ac-focus-defaults: with default options every focus state decides the same way", () => {
    const focuses: Focus[] = ["focused", "unfocused", "unknown"]
    const unfocusedSince = start.now - 60 * MINUTE

    for (const focus of focuses) {
      const notIdle = input({ focus, unfocusedSince, now: start.lastInputAt + 5 * MINUTE })
      expect(decide(notIdle, options)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

      const shortlyUnfocused = input({ focus, unfocusedSince: start.now, now: start.now + 10_000 })
      expect(decide(shortlyUnfocused, options)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

      const idle = input({ focus, unfocusedSince, now: start.lastInputAt + 15 * MINUTE })
      expect(decide(idle, options)).toEqual({ action: "nap", rule: "idle" })
    }
  })

  it("ac-focus-not-input: a focus change does not reset the idle clock", () => {
    const beforeChange = input({ now: start.lastInputAt + 14 * MINUTE, focus: "focused" })
    expect(decide(beforeChange, options)).toEqual({ action: "wait", checkAfterMs: 5_000, deferred: [] })

    const afterChange = input({
      now: start.lastInputAt + 15 * MINUTE,
      focus: "unfocused",
      unfocusedSince: start.lastInputAt + 14 * MINUTE,
    })
    expect(decide(afterChange, bothOn)).toEqual({ action: "nap", rule: "idle" })
  })
})

describe("decide (rule precedence)", () => {
  it("reports idle first when idle, blurIdle and blur are all due", () => {
    expect(
      decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.lastInputAt + 15 * MINUTE }), bothOn),
    ).toEqual({ action: "nap", rule: "idle" })
  })

  it("reports blurIdle before blur when both are due", () => {
    expect(
      decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.lastInputAt + 5 * MINUTE }), bothOn),
    ).toEqual({ action: "nap", rule: "blurIdle" })
  })

  it("reports blur when only the blur debounce is due", () => {
    expect(decide(input({ focus: "unfocused", unfocusedSince: start.now, now: start.now + 10_000 }), bothOn)).toEqual({
      action: "nap",
      rule: "blur",
    })
  })
})
