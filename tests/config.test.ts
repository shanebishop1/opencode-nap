import { describe, expect, it } from "bun:test"
import { defaults, parseOptions } from "../src/config.js"

describe("defaults", () => {
  it("naps after fifteen idle minutes, keeps the draft, and does not nap on blur", () => {
    expect(defaults).toEqual({
      enabled: true,
      idleMinutes: 15,
      napOnBlur: false,
      blurIdleMinutes: undefined,
      carryDraft: true,
      debugLogFile: undefined,
    })
  })
})

describe("parseOptions", () => {
  it("treats undefined, null, and an empty object as defaults", () => {
    for (const raw of [undefined, null, {}]) {
      expect(parseOptions(raw)).toEqual({ ok: true, options: defaults })
    }
  })

  it("accepts valid values for each option", () => {
    expect(parseOptions({ enabled: false })).toEqual({ ok: true, options: { ...defaults, enabled: false } })
    expect(parseOptions({ idleMinutes: 30 })).toEqual({ ok: true, options: { ...defaults, idleMinutes: 30 } })
    expect(parseOptions({ napOnBlur: true })).toEqual({ ok: true, options: { ...defaults, napOnBlur: true } })
    expect(parseOptions({ blurIdleMinutes: 5 })).toEqual({ ok: true, options: { ...defaults, blurIdleMinutes: 5 } })
    expect(parseOptions({ carryDraft: false })).toEqual({ ok: true, options: { ...defaults, carryDraft: false } })
    expect(parseOptions({ debugLogFile: "/tmp/nap.log" })).toEqual({
      ok: true,
      options: { ...defaults, debugLogFile: "/tmp/nap.log" },
    })
  })

  it("rejects non-boolean values for boolean options", () => {
    for (const raw of [{ enabled: "yes" }, { napOnBlur: 1 }, { carryDraft: null }]) {
      const result = parseOptions(raw)
      expect(result.ok).toBe(false)
    }
    expect(parseOptions({ enabled: "yes" })).toEqual({
      ok: false,
      message: 'invalid option "enabled": must be true or false',
    })
    expect(parseOptions({ carryDraft: "no" })).toEqual({
      ok: false,
      message: 'invalid option "carryDraft": must be true or false',
    })
  })

  it("rejects idle minutes that are not finite numbers greater than zero", () => {
    for (const idleMinutes of [0, -1, "15", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseOptions({ idleMinutes })).toEqual({
        ok: false,
        message: 'invalid option "idleMinutes": must be a number greater than 0',
      })
    }
  })

  it("rejects blur idle minutes that are not finite numbers greater than zero", () => {
    for (const blurIdleMinutes of [0, -2, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseOptions({ blurIdleMinutes })).toEqual({
        ok: false,
        message: 'invalid option "blurIdleMinutes": must be a number greater than 0',
      })
    }
  })

  it("rejects a debug log file that is not an absolute path", () => {
    for (const debugLogFile of ["nap.log", "", 42]) {
      expect(parseOptions({ debugLogFile })).toEqual({
        ok: false,
        message: 'invalid option "debugLogFile": must be an absolute path',
      })
    }
  })

  it("rejects unknown keys so typos are caught", () => {
    expect(parseOptions({ idleMinute: 5 })).toEqual({
      ok: false,
      message: 'unknown option "idleMinute"',
    })
    expect(parseOptions({ idleMinute: 5, carryDrafts: true })).toEqual({
      ok: false,
      message: 'unknown options "idleMinute", "carryDrafts"',
    })
  })

  it("accepts fractional minutes", () => {
    expect(parseOptions({ idleMinutes: 0.25 })).toEqual({ ok: true, options: { ...defaults, idleMinutes: 0.25 } })
    expect(parseOptions({ blurIdleMinutes: 0.5 })).toEqual({ ok: true, options: { ...defaults, blurIdleMinutes: 0.5 } })
  })

  it("names one option in a single-line message without a raw zod dump", () => {
    const result = parseOptions({ idleMinutes: -3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).not.toContain("\n")
    expect(result.message).not.toContain("ZodError")
    expect(result.message).toContain("idleMinutes")
  })

  it("rejects options that are not an object", () => {
    expect(parseOptions("nap")).toEqual({ ok: false, message: "invalid options: must be an object" })
    expect(parseOptions([])).toEqual({ ok: false, message: "invalid options: must be an object" })
  })
})
