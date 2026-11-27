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
      home: "/home/me",
      serverVersion: "2.2.7",
      session: () => ({ title: "Title", directory: "/work/project" }),
      card: session => `card for ${String(session.title)} in ${String(session.directory)}`,
      wakeOnFocus: false,
      stillDue: () => true,
      execve: (...args) => {
        calls.push(args)
        throw new Error("ENOENT")
      },
      ...overrides,
    }
  }

  it("execs the stub with the card, the wake command line and the environment", () => {
    const parkInput = input()
    expect(park(parkInput)).toEqual({ status: "exec-failed", error: new Error("ENOENT") })
    const stub = buildStubExec({ card: "card for Title in /work/project", terminalTitle: "OC | Title", wakeOnFocus: false, opencodePath: "/bin/opencode", args: ["--server", "http://127.0.0.1:1", "/abs/project", "-s", "ses_a"] })
    expect(parkInput.calls).toEqual([[stub.file, stub.argv, { PATH: "/usr/bin" }]])
  })

  it("builds the card without session facts on a route that is not a session", () => {
    const parkInput = input({ route: { type: "home" }, session: () => { throw new Error("unexpected lookup") } })
    park(parkInput)
    expect((parkInput.calls[0][1] as string[])[4]).toBe("\x1b]0;OpenCode\x07card for undefined in undefined")
  })

  it("uses OpenCode's route title when no live title was captured", () => {
    for (const [title, expected] of [
      [undefined, "OpenCode"],
      ["New session - 2026-11-27T10:00:00.000Z", "OpenCode"],
      ["Child session - 2026-11-27T10:00:00.000Z", "OpenCode"],
      ["a".repeat(40), `OC | ${"a".repeat(40)}`],
      ["a".repeat(41), `OC | ${"a".repeat(37)}…`],
    ]) {
      const parkInput = input({ session: () => ({ title }) })
      park(parkInput)
      expect((parkInput.calls[0][1] as string[])[4]).toStartWith(`\x1b]0;${expected}\x07`)
    }
    const plugin = input({ route: { type: "plugin", id: "x", name: "Review" } })
    park(plugin)
    expect((plugin.calls[0][1] as string[])[4]).toStartWith("\x1b]0;OC | Review\x07")
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

  const stubArgs = (parkInput: ReturnType<typeof input>) => (parkInput.calls[0][1] as string[]).slice(5)

  it("ac-service-attach: a window on the background service gives the stub its registration and version", () => {
    const parkInput = input({ args: ["project"] })
    park(parkInput)
    expect(stubArgs(parkInput)).toEqual(["keys", "/bin/opencode", "/home/me/.local/state/opencode/service.json", "2.2.7", "/abs/project", "-s", "ses_a"])
  })

  it("ac-service-attach: a window that names its server, or whose server version is unknown, gets none", () => {
    const named = input()
    park(named)
    expect(stubArgs(named).slice(2, 4)).toEqual(["", ""])
    const unknown = input({ args: [], serverVersion: undefined })
    park(unknown)
    expect(stubArgs(unknown).slice(2, 4)).toEqual(["", ""])
  })

  it("ac-service-attach: the --server an earlier wake added is dropped, with its password and marker", () => {
    const url = "http://127.0.0.1:49374"
    const parkInput = input({
      args: ["--server", url, "-s", "ses_old", "project"],
      env: { PATH: "/usr/bin", XDG_STATE_HOME: "/state", OPENCODE_PASSWORD: "pw", OPENCODE_NAP_SERVER: url },
    })
    park(parkInput)
    expect(stubArgs(parkInput)).toEqual(["keys", "/bin/opencode", "/state/opencode/service.json", "2.2.7", "/abs/project", "-s", "ses_a"])
    expect(parkInput.calls[0][2]).toEqual({ PATH: "/usr/bin", XDG_STATE_HOME: "/state" })
  })
})
