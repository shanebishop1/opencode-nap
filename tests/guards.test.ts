import { describe, expect, it } from "bun:test"
import { checkGuards, collectGuardFacts, type GuardFacts } from "../src/guards.js"

const safe: GuardFacts = {
  platform: "linux",
  hasExecve: true,
  isMainThread: true,
  args: [],
  pid: 100,
  serverPid: 200,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  shExecutable: true,
  enabled: true,
}

const withFacts = (overrides: Partial<GuardFacts>): GuardFacts => ({ ...safe, ...overrides })

describe("checkGuards", () => {
  it("passes when every guard is satisfied", () => {
    expect(checkGuards(safe)).toEqual({ ok: true })
  })

  it("refuses when disabled in options", () => {
    expect(checkGuards(withFacts({ enabled: false }))).toEqual({ ok: false, reason: "disabled in options" })
  })

  it("refuses on Windows", () => {
    expect(checkGuards(withFacts({ platform: "win32" }))).toEqual({ ok: false, reason: "Windows is not supported" })
  })

  it("accepts macOS", () => {
    expect(checkGuards(withFacts({ platform: "darwin" }))).toEqual({ ok: true })
  })

  it("refuses other platforms, including one that could not be read", () => {
    expect(checkGuards(withFacts({ platform: "freebsd" }))).toEqual({
      ok: false,
      reason: 'platform "freebsd" is not supported',
    })
    expect(checkGuards(withFacts({ platform: "unknown" }))).toEqual({
      ok: false,
      reason: 'platform "unknown" is not supported',
    })
  })

  it("refuses when process.execve is unavailable", () => {
    expect(checkGuards(withFacts({ hasExecve: false }))).toEqual({
      ok: false,
      reason: "process.execve is not available",
    })
  })

  it("refuses off the main thread", () => {
    expect(checkGuards(withFacts({ isMainThread: false }))).toEqual({
      ok: false,
      reason: "not on the main thread",
    })
  })

  it("refuses when started with --standalone", () => {
    expect(checkGuards(withFacts({ args: ["--standalone"] }))).toEqual({
      ok: false,
      reason: "started with --standalone: the server runs in this process",
    })
  })

  it("refuses when started with --standalone=true", () => {
    expect(checkGuards(withFacts({ args: ["--port", "4096", "--standalone=true"] }))).toEqual({
      ok: false,
      reason: "started with --standalone: the server runs in this process",
    })
  })

  it("does not refuse a flag that only starts with --standalone", () => {
    expect(checkGuards(withFacts({ args: ["--standalone-mode"] }))).toEqual({ ok: true })
  })

  it("refuses when the server runs in this process", () => {
    expect(checkGuards(withFacts({ serverPid: 100, pid: 100 }))).toEqual({
      ok: false,
      reason: "the server runs in this process",
    })
  })

  it("refuses when the server pid is unknown", () => {
    expect(checkGuards(withFacts({ serverPid: undefined }))).toEqual({
      ok: false,
      reason: "the server pid is unknown",
    })
  })

  it("refuses when stdin is not a terminal", () => {
    expect(checkGuards(withFacts({ stdinIsTTY: false }))).toEqual({
      ok: false,
      reason: "stdin and stdout must be a terminal",
    })
  })

  it("refuses when stdout is not a terminal", () => {
    expect(checkGuards(withFacts({ stdoutIsTTY: false }))).toEqual({
      ok: false,
      reason: "stdin and stdout must be a terminal",
    })
  })

  it("refuses when /bin/sh is not executable", () => {
    expect(checkGuards(withFacts({ shExecutable: false }))).toEqual({
      ok: false,
      reason: "/bin/sh is not executable",
    })
  })

  it("checks in order, so Windows with disabled options reports the disabled reason", () => {
    expect(checkGuards(withFacts({ enabled: false, platform: "win32" }))).toEqual({
      ok: false,
      reason: "disabled in options",
    })
  })
})

describe("collectGuardFacts", () => {
  it("returns real process facts as booleans without throwing", () => {
    const facts = collectGuardFacts({ enabled: true, serverPid: undefined })

    expect(facts.enabled).toBe(true)
    expect(facts.serverPid).toBeUndefined()
    expect(facts.platform).toBe(process.platform)
    expect(facts.pid).toBe(process.pid)
    expect(facts.args).toEqual(process.argv.slice(2))
    expect(typeof facts.hasExecve).toBe("boolean")
    expect(typeof facts.isMainThread).toBe("boolean")
    expect(typeof facts.stdinIsTTY).toBe("boolean")
    expect(typeof facts.stdoutIsTTY).toBe("boolean")
    expect(typeof facts.shExecutable).toBe("boolean")
  })

  it("takes the unsafe value for a fact that cannot be read", () => {
    const argv = Object.getOwnPropertyDescriptor(process, "argv")
    Object.defineProperty(process, "argv", { configurable: true, get: () => { throw new Error("unreadable") } })
    try {
      const facts = collectGuardFacts({ enabled: true, serverPid: 1 })
      expect(facts.args).toEqual(["--standalone"])
      expect(checkGuards({ ...facts, platform: "linux", hasExecve: true, isMainThread: true })).toEqual({
        ok: false,
        reason: "started with --standalone: the server runs in this process",
      })
    } finally {
      if (argv) Object.defineProperty(process, "argv", argv)
    }
  })
})

describe("on Windows", () => {
  it.skipIf(process.platform !== "win32")("turns the plugin off without throwing", () => {
    expect(checkGuards(collectGuardFacts({ enabled: true, serverPid: 1 }))).toEqual({
      ok: false,
      reason: "Windows is not supported",
    })
  })
})
