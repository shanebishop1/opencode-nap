import { describe, expect, it } from "bun:test"
import { NapDeferral, park, toWakeRoute, type ParkInput } from "../src/park.js"
import { buildStubExec } from "../src/stub.js"

describe("toWakeRoute", () => {
  it("maps session routes and treats every other route as the start screen", () => {
    expect(toWakeRoute({ type: "session", sessionID: "ses_a" })).toEqual({ type: "session", sessionID: "ses_a" })
    expect(toWakeRoute({ type: "home" })).toEqual({ type: "other" })
    expect(toWakeRoute({ type: "plugin", id: "x", name: "y" })).toEqual({ type: "other" })
  })

  it("throws on an unexpected shape", () => {
    expect(() => toWakeRoute(undefined)).toThrow()
    expect(() => toWakeRoute({ sessionID: "ses_a" })).toThrow()
    expect(() => toWakeRoute({ type: "session" })).toThrow()
  })
})

describe("park", () => {
  const input = (overrides: Partial<ParkInput> = {}): ParkInput & { calls: unknown[][] } => {
    const calls: unknown[][] = []
    return {
      calls,
      route: { type: "session", sessionID: "ses_a" },
      args: ["--server", "http://127.0.0.1:1", "-c", "project"],
      resolveDirectory: arg => `/abs/${arg}`,
      opencodePath: "/bin/opencode",
      env: { PATH: "/usr/bin" },
      title: () => "Title",
      stillDue: () => true,
      execve: (...args) => {
        calls.push(args)
        throw new Error("ENOENT")
      },
      ...overrides,
    }
  }

  it("execs the stub with the card title, the wake command line and the environment", () => {
    const parkInput = input()
    expect(park(parkInput)).toEqual({ status: "exec-failed", error: new Error("ENOENT") })
    const stub = buildStubExec({ cardTitle: "Title", opencodePath: "/bin/opencode", args: ["--server", "http://127.0.0.1:1", "/abs/project", "-s", "ses_a"] })
    expect(parkInput.calls).toEqual([[stub.file, stub.argv, { PATH: "/usr/bin" }]])
  })

  it("leaves the title off when it is not a string", () => {
    const parkInput = input({ title: () => undefined })
    park(parkInput)
    expect((parkInput.calls[0][1] as string[])[4]).toBe("")
  })

  it("skips when the wake command line cannot be built", () => {
    const parkInput = input({ route: { type: "session", sessionID: "--x" } })
    expect(park(parkInput)).toEqual({ status: "skipped", reason: 'cannot build the wake command line: invalid session id "--x"' })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("merges the environment from beforeNap", () => {
    const parkInput = input({ beforeNap: () => ({ EXTRA: "yes" }) })
    park(parkInput)
    expect(parkInput.calls[0][2]).toEqual({ PATH: "/usr/bin", EXTRA: "yes" })
  })

  it("skips with the reason a beforeNap deferral gives", () => {
    const parkInput = input({ beforeNap: () => new NapDeferral("cannot read the draft") })
    expect(park(parkInput)).toEqual({ status: "skipped", reason: "cannot read the draft" })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("saves the draft before the final due check and exec", () => {
    const order: string[] = []
    const parkInput = input({
      beforeNap: () => {
        order.push("beforeNap")
        return undefined
      },
      stillDue: () => {
        order.push("stillDue")
        return true
      },
      execve: () => { order.push("execve") },
    })
    park(parkInput)
    expect(order).toEqual(["beforeNap", "stillDue", "execve"])
  })

  it("does not exec if the nap is no longer due after capture", () => {
    const parkInput = input({ stillDue: () => false })
    expect(park(parkInput)).toEqual({ status: "skipped", reason: "no longer due before exec" })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("reports an execve that returns as a failure", () => {
    expect(park(input({ execve: () => {} }))).toEqual({ status: "exec-failed", error: new Error("execve returned") })
  })
})
