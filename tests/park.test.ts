import { describe, expect, it } from "bun:test"
import { park, toWakeRoute, type ParkInput } from "../src/park.js"
import { createPendingWrites } from "../src/pending.js"
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
      pending: createPendingWrites(),
      stillDue: () => true,
      execve: (...args) => {
        calls.push(args)
        throw new Error("ENOENT")
      },
      ...overrides,
    }
  }

  it("execs the stub with the card title, the wake command line and the environment", async () => {
    const parkInput = input()
    expect(await park(parkInput)).toEqual({ status: "exec-failed", error: new Error("ENOENT") })
    const stub = buildStubExec({ cardTitle: "Title", opencodePath: "/bin/opencode", args: ["--server", "http://127.0.0.1:1", "/abs/project", "-s", "ses_a"] })
    expect(parkInput.calls).toEqual([[stub.file, stub.argv, { PATH: "/usr/bin" }]])
  })

  it("leaves the title off when it is not a string", async () => {
    const parkInput = input({ title: () => undefined })
    await park(parkInput)
    expect((parkInput.calls[0][1] as string[])[4]).toBe("")
  })

  it("skips when the wake command line cannot be built", async () => {
    const parkInput = input({ route: { type: "session", sessionID: "--x" } })
    expect(await park(parkInput)).toEqual({ status: "skipped", reason: 'cannot build the wake command line: invalid session id "--x"' })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("merges the environment from beforeNap after waiting for it", async () => {
    const parkInput = input({ beforeNap: async () => ({ EXTRA: "yes" }) })
    await park(parkInput)
    expect(parkInput.calls[0][2]).toEqual({ PATH: "/usr/bin", EXTRA: "yes" })
  })

  it("waits for pending writes, then checks the nap is still due", async () => {
    const pending = createPendingWrites()
    let finish = () => {}
    void pending.track(new Promise<void>(done => { finish = done }))
    let due = true
    const parkInput = input({ pending, stillDue: () => due })
    const result = park(parkInput)
    await new Promise(done => setTimeout(done, 0))
    expect(parkInput.calls).toHaveLength(0)
    due = false
    finish()
    expect(await result).toEqual({ status: "skipped", reason: "no longer due after waiting" })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("skips when the writes outlast their limit", async () => {
    const parkInput = input({ pending: { track: write => write, settled: async () => false } })
    expect(await park(parkInput)).toEqual({ status: "skipped", reason: "the plugin's storage writes took too long" })
    expect(parkInput.calls).toHaveLength(0)
  })

  it("a failed write does not block the nap", async () => {
    const pending = createPendingWrites()
    void pending.track(Promise.reject(new Error("disk full"))).catch(() => {})
    const parkInput = input({ pending })
    await park(parkInput)
    expect(parkInput.calls).toHaveLength(1)
  })

  it("reports an execve that returns as a failure", async () => {
    expect(await park(input({ execve: () => {} }))).toEqual({ status: "exec-failed", error: new Error("execve returned") })
  })
})
