import { describe, expect, it } from "bun:test"
import type { GuardFacts } from "../src/guards.js"
import { napCard, plainCard } from "../src/card.js"
import { readPalette } from "../src/palette.js"
import { buildStubExec } from "../src/stub.js"
import { startNap } from "../src/tui.js"
import { withoutSequences } from "./grid.js"
import { fakeContext, fakeLog, fakeProcess, fakeTheme, settle, SERVER_URL, SESSION_ID } from "./fakes.js"

const IDLE_MS = 60_000
const options = { idleMinutes: IDLE_MS / 60_000 }

type Setup = {
  args?: string[]
  facts?: Partial<GuardFacts>
  options?: unknown
  edit?: (context: ReturnType<typeof fakeContext>) => void
}

async function start(setup: Setup = {}) {
  const fake = fakeProcess({ args: setup.args, facts: setup.facts })
  const context = fakeContext(fake.stdin)
  setup.edit?.(context)
  const log = fakeLog()
  const cleanup = startNap(context, "options" in setup ? setup.options : options, log, fake.proc)
  await settle()
  const listeners = () => context.renderer.count() + context.renderer.keyInput.count() + fake.stdin.count()
  return { fake, context, log, cleanup, listeners }
}

const messages = (log: ReturnType<typeof fakeLog>) => log.entries.map(entry => entry.message)

describe("startNap", () => {
  it("ac-idle-nap: execs the stub with the wake command line and the TUI's environment once idle", async () => {
    const { fake, log } = await start()
    expect(messages(log)).toEqual(["watching"])

    await fake.advance(IDLE_MS - 1_000)
    expect(fake.execs).toHaveLength(0)
    await fake.advance(6_000)

    expect(fake.execs).toHaveLength(1)
    const expected = buildStubExec({
      card: napCard({
        size: { width: 120, height: 36 },
        palette: readPalette(fakeTheme()),
        title: "Fix the flaky test",
        directory: "/work/project",
        home: "/home/shane",
        version: "2.2.4",
      }),
      opencodePath: "/opt/opencode/bin/opencode",
      args: ["--server", SERVER_URL, "-s", SESSION_ID],
    })
    expect(fake.execs[0]).toEqual({ file: "/bin/sh", argv: expected.argv, env: { PATH: "/usr/bin", OPENCODE_PASSWORD: "secret" } })
    expect(log.entries.find(entry => entry.message === "napping")?.detail).toEqual({
      rule: "idle",
      route: { type: "session", sessionID: SESSION_ID },
    })
  })

  it("ac-home-route: naps on a non-session route without -s or a title", async () => {
    const { fake } = await start({ edit: context => { context.route = { type: "home" } } })
    await fake.advance(IDLE_MS + 5_000)
    const [card, ...rest] = fake.execs[0].argv.slice(4)
    expect(rest).toEqual(["/opt/opencode/bin/opencode", "--server", SERVER_URL])
    expect(withoutSequences(card)).toContain("Napping · work keeps running")
    expect(withoutSequences(card)).toContain("/work/project")
  })

  describe("the nap card falls back instead of stopping the nap", () => {
    const cardOf = async (setup: Setup) => {
      const { fake } = await start(setup)
      await fake.advance(IDLE_MS + 5_000)
      return fake.execs[0].argv[4]
    }

    it("uses OpenCode's default colours when the theme cannot be read", async () => {
      const card = await cardOf({ edit: context => { context.theme = undefined } })
      expect(card).toContain(";48;2;10;10;10m")
      expect(withoutSequences(card)).toContain("Fix the flaky test")
    })

    it("uses the plain text when the terminal size is unknown", async () => {
      const { fake } = await start()
      fake.state.size = undefined
      await fake.advance(IDLE_MS + 5_000)
      expect(fake.execs[0].argv[4]).toBe(plainCard("Fix the flaky test"))
    })

    it("uses the plain text when reading the host throws", async () => {
      const card = await cardOf({ edit: context => { Object.defineProperty(context, "app", { get: () => { throw new Error("gone") } }) } })
      expect(card).toBe(plainCard("Fix the flaky test"))
    })
  })

  it("makes a relative directory argument absolute", async () => {
    const { fake } = await start({ args: ["--server", SERVER_URL, "project"] })
    await fake.advance(IDLE_MS + 5_000)
    expect(fake.execs[0].argv.slice(6)).toEqual(["--server", SERVER_URL, "/work/project", "-s", SESSION_ID])
  })

  it("ac-exec-fails: an execve that throws turns the plugin off without a retry", async () => {
    const { fake, log, listeners } = await start()
    fake.state.execveError = Object.assign(new Error("EACCES"), { code: "EACCES" })

    await fake.advance(IDLE_MS + 5_000)
    await fake.advance(10 * IDLE_MS)

    expect(fake.execs).toHaveLength(1)
    expect(log.entries.filter(entry => entry.message === "off: exec failed")).toEqual([
      { message: "off: exec failed", detail: { error: "EACCES" } },
    ])
    expect(fake.timers.size).toBe(0)
    expect(listeners()).toBe(0)
  })

  it("ac-input-resets: a key press, paste or mouse report restarts the idle time", async () => {
    for (const send of [
      (context: ReturnType<typeof fakeContext>) => context.renderer.keyInput.emit("keypress", { name: "a" }),
      (context: ReturnType<typeof fakeContext>) => context.renderer.keyInput.emit("paste", { bytes: new Uint8Array([120]) }),
      (context: ReturnType<typeof fakeContext>) => context.renderer.stdin.emit("data", Buffer.from("\x1b[<35;10;10M")),
    ]) {
      const { fake, context } = await start()
      await fake.advance(IDLE_MS - 10_000)
      send(context)
      await fake.advance(IDLE_MS - 5_000)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(10_000)
      expect(fake.execs).toHaveLength(1)
    }
  })

  it("ac-focus-not-input: focus reports and the access-time bump they cause do not restart the idle time", async () => {
    // With and without a focus option that leaves the plain idle rule in charge.
    for (const setup of [{}, { options: { ...options, blurIdleMinutes: 5 } }]) {
      const { fake, context } = await start(setup)
      const startedAt = fake.now()
      await fake.advance(IDLE_MS - 10_000)
      for (const report of ["\x1b[O", "\x1b[I"]) {
        // In OpenCode's order: the read bumps the access time, then the
        // renderer, which listened first, sees the chunk before the plugin.
        fake.setAtime(Math.floor(fake.now() / 1_000) * 1_000)
        context.renderer.emit(report === "\x1b[O" ? "blur" : "focus")
        fake.stdin.emit("data", Buffer.from(report))
        await fake.advance(2_000)
      }
      await fake.advance(IDLE_MS - (fake.now() - startedAt) + 5_000)
      expect(fake.execs).toHaveLength(1)
    }
  })

  it("counts an access-time bump the renderer did not see, such as typing into an external editor", async () => {
    const { fake } = await start()
    await fake.advance(IDLE_MS - 10_000)
    fake.setAtime(fake.now())
    await fake.advance(IDLE_MS - 5_000)
    expect(fake.execs).toHaveLength(0)
    await fake.advance(10_000)
    expect(fake.execs).toHaveLength(1)
  })

  it("never naps while the renderer is suspended for an external editor, and naps once it resumes", async () => {
    const { fake, context, log } = await start()
    context.renderer.controlState = "explicit_suspended"
    await fake.advance(10 * IDLE_MS)
    expect(fake.execs).toHaveLength(0)
    expect(messages(log)).toEqual(["watching", "nap deferred: the terminal is handed to another program"])
    context.renderer.controlState = "auto_started"
    await fake.advance(5_000)
    expect(fake.execs).toHaveLength(1)
  })

  describe("focus rules", () => {
    const napRule = (log: ReturnType<typeof fakeLog>) => log.entries.find(entry => entry.message === "napping")?.detail.rule

    it("ac-nap-on-blur: naps 2 seconds after the window loses focus, without waiting for the next check", async () => {
      const { fake, context, log } = await start({ options: { ...options, napOnBlur: true } })
      // Mid-way through a five-second check interval.
      await fake.advance(11_000)
      context.renderer.emit("blur")
      await fake.advance(1_999)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(1)
      expect(fake.execs).toHaveLength(1)
      expect(napRule(log)).toBe("blur")
    })

    it("ac-blur-debounce: regaining focus within 2 seconds does not nap", async () => {
      const { fake, context, log } = await start({ options: { ...options, napOnBlur: true } })
      await fake.advance(10_000)
      context.renderer.emit("blur")
      await fake.advance(1_500)
      context.renderer.emit("focus")
      await fake.advance(IDLE_MS - 12_000)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(5_000)
      expect(napRule(log)).toBe("idle")
    })

    it("ac-blur-idle: naps an unfocused window after blurIdleMinutes, before idleMinutes", async () => {
      const { fake, context, log } = await start({ options: { idleMinutes: 10, blurIdleMinutes: 1 } })
      context.renderer.emit("blur")
      await fake.advance(IDLE_MS - 1_000)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(6_000)
      expect(fake.execs).toHaveLength(1)
      expect(napRule(log)).toBe("blurIdle")
    })

    it("ac-blur-idle: losing focus after blurIdleMinutes of idle naps at once", async () => {
      const { fake, context, log } = await start({ options: { idleMinutes: 10, blurIdleMinutes: 1 } })
      context.renderer.emit("focus")
      await fake.advance(2 * IDLE_MS)
      expect(fake.execs).toHaveLength(0)
      context.renderer.emit("blur")
      await fake.advance(0)
      expect(fake.execs).toHaveLength(1)
      expect(napRule(log)).toBe("blurIdle")
    })

    it("ac-focus-unknown: with no focus event, only idleMinutes naps", async () => {
      const { fake, log } = await start({ options: { idleMinutes: 1, napOnBlur: true, blurIdleMinutes: 0.1 } })
      await fake.advance(IDLE_MS - 1_000)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(6_000)
      expect(fake.execs).toHaveLength(1)
      expect(napRule(log)).toBe("idle")
    })

    it("ac-focus-defaults: with neither option set, losing focus changes nothing", async () => {
      const { fake, context, log } = await start({ options: { idleMinutes: 1 } })
      context.renderer.emit("blur")
      await fake.advance(IDLE_MS - 1_000)
      expect(fake.execs).toHaveLength(0)
      await fake.advance(6_000)
      expect(fake.execs).toHaveLength(1)
      expect(napRule(log)).toBe("idle")
    })
  })

  describe("ac-refuse: logs the reason once and never naps", () => {
    const cases: Array<[string, Setup, string]> = [
      ["Windows", { facts: { platform: "win32" } }, "Windows is not supported"],
      ["no execve", { facts: { hasExecve: false } }, "process.execve is not available"],
      ["off the main thread", { facts: { isMainThread: false } }, "not on the main thread"],
      ["--standalone", { args: ["--standalone"] }, "started with --standalone: the server runs in this process"],
      ["server pid is the TUI's", { edit: context => { context.serverPid = 100 } }, "the server runs in this process"],
      ["server pid unknown", { edit: context => { context.serverPid = "200" } }, "the server pid is unknown"],
      ["server info fails", { edit: context => { context.client.server.info = async () => { throw new Error("down") } } }, "the server pid is unknown"],
      ["no TTY", { facts: { stdinIsTTY: false } }, "stdin and stdout must be a terminal"],
      ["no /bin/sh", { facts: { shExecutable: false } }, "/bin/sh is not executable"],
      ["disabled", { options: { enabled: false } }, "disabled in options"],
    ]
    for (const [name, setup, reason] of cases) {
      it(name, async () => {
        const { fake, log, listeners } = await start(setup)
        await fake.advance(10 * IDLE_MS)
        expect(log.entries).toEqual([{ message: "refused", detail: { reason } }])
        expect(fake.execs).toHaveLength(0)
        expect(fake.timers.size).toBe(0)
        expect(listeners()).toBe(0)
      })
    }
  })

  it("ac-unknown-args: a subcommand or unknown flag logs once and never naps", async () => {
    for (const [args, reason] of [
      [["run"], 'subcommand "run" is not allowed'],
      [["--frobnicate"], 'unknown argument "--frobnicate"'],
    ] as const) {
      const { fake, log } = await start({ args: [...args] })
      await fake.advance(10 * IDLE_MS)
      expect(log.entries).toEqual([{ message: "refused", detail: { reason } }])
      expect(fake.execs).toHaveLength(0)
    }
  })

  it("invalid options turn the plugin off with one log line", async () => {
    const { fake, log, listeners } = await start({ options: { idleMinutes: 0 } })
    await fake.advance(10 * IDLE_MS)
    expect(log.entries).toEqual([
      { message: "off: invalid options", detail: { message: 'invalid option "idleMinutes": must be a number greater than 0' } },
    ])
    expect(fake.execs).toHaveLength(0)
    expect(listeners()).toBe(0)
  })

  describe("ac-fail-safe: a missing internal turns the plugin off", () => {
    const removals: Array<[string, (context: any) => void]> = [
      ["ui.router.current", context => { delete context.ui.router.current }],
      ["client.server.info", context => { context.client.server = {} }],
      ["data.session.get", context => { context.data.session.get = "nope" }],
      ["renderer.on/off", context => { context.renderer.off = undefined }],
      ["renderer.keyInput.on/off", context => { delete context.renderer.keyInput }],
      ["renderer.controlState", context => { context.renderer.controlState = undefined }],
      ["renderer.stdin", context => { context.renderer.stdin = {} }],
    ]
    for (const [name, remove] of removals) {
      it(name, async () => {
        const { fake, log } = await start({ edit: remove })
        await fake.advance(10 * IDLE_MS)
        expect(log.entries).toEqual([{ message: "off: missing OpenCode internal", detail: { name } }])
        expect(fake.execs).toHaveLength(0)
        expect(fake.timers.size).toBe(0)
      })
    }
  })

  describe("ac-fail-safe: an internal that throws at runtime turns the plugin off", () => {
    const breakages: Array<[string, (context: any) => void]> = [
      ["the route lookup throws", context => { context.ui.router.current = () => { throw new Error("router gone") } }],
      ["the route has an unexpected shape", context => { context.route = "session" }],
      ["the title lookup throws", context => { context.data.session.get = () => { throw new Error("no data") } }],
    ]
    for (const [name, breakIt] of breakages) {
      it(name, async () => {
        const { fake, log, listeners } = await start({ edit: breakIt })
        await fake.advance(IDLE_MS + 5_000)
        await fake.advance(10 * IDLE_MS)
        expect(messages(log)).toEqual(["watching", "off: runtime error"])
        expect(fake.execs).toHaveLength(0)
        expect(fake.timers.size).toBe(0)
        expect(listeners()).toBe(0)
      })
    }

    it("the access time read throws", async () => {
      const { fake, log } = await start()
      fake.state.atimeError = new Error("EBADF")
      await fake.advance(IDLE_MS + 5_000)
      expect(messages(log)).toEqual(["watching", "off: runtime error"])
      expect(fake.execs).toHaveLength(0)
    })
  })

  it("skips a nap whose command line cannot be built, logs once and tries again", async () => {
    const { fake, log, context } = await start({ edit: context => { context.route = { type: "session", sessionID: "-x" } } })
    await fake.advance(IDLE_MS + 30_000)
    expect(fake.execs).toHaveLength(0)
    expect(messages(log).filter(message => message.startsWith("nap skipped"))).toEqual([
      'nap skipped: cannot build the wake command line: invalid session id "-x"',
    ])
    context.route = { type: "session", sessionID: SESSION_ID }
    await fake.advance(5_000)
    expect(fake.execs).toHaveLength(1)
  })

  it("cleanup removes the timer and every listener", async () => {
    const { fake, cleanup, listeners } = await start()
    // Idle (3), focus (2) and the draft's focused-editor tracking (1).
    expect(listeners()).toBe(6)
    expect(fake.timers.size).toBe(1)
    cleanup()
    expect(listeners()).toBe(0)
    expect(fake.timers.size).toBe(0)
    await fake.advance(10 * IDLE_MS)
    expect(fake.execs).toHaveLength(0)
  })

  it("cleanup before the server answers never starts the loop", async () => {
    const fake = fakeProcess()
    const context = fakeContext(fake.stdin)
    const log = fakeLog()
    const cleanup = startNap(context, options, log, fake.proc)
    cleanup()
    await fake.advance(10 * IDLE_MS)
    expect(log.entries).toEqual([])
    expect(fake.stdin.count() + context.renderer.count()).toBe(0)
  })
})
