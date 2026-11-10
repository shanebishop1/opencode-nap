import { fstatSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/tui"
import { buildWakeArgs } from "./argv.js"
import { parseOptions } from "./config.js"
import { createFocusSource, type FocusSource } from "./focus.js"
import { checkGuards, collectGuardFacts, type GuardFacts } from "./guards.js"
import { createIdleSource, type IdleSource } from "./idle.js"
import { createLog, type Log } from "./log.js"
import {
  createPendingWrites,
  directoryResolver,
  park,
  sameDirectory,
  type Execve,
  type ParkInput,
  type PendingWrites,
  type StartDirectory,
} from "./park.js"
import { decide } from "./policy.js"
import { probe } from "./probe.js"

/** Process facts and effects, injected so tests can fake them. */
export interface NapProcess {
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** The TUI's arguments after the executable and script. */
  args: string[]
  execPath: string
  env(): NodeJS.ProcessEnv
  start: StartDirectory
  stdin: unknown
  readAtime(): number | undefined
  guardFacts(serverPid: number | undefined): GuardFacts
  execve: Execve
}

/** Seams for later features: draft capture and the plugin's own storage writes. */
export interface NapHooks {
  beforeNap?: ParkInput["beforeNap"]
  pending?: PendingWrites
}

// How soon to try again after a nap was skipped at nap time.
const SKIP_RETRY_MS = 5_000

const TERMINAL_HANDED_OFF = "the terminal is handed to another program"

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * Runs the plugin for one TUI and returns its cleanup. Every way of turning
 * off writes one log line and leaves the TUI as it was.
 */
export function startNap(context: unknown, rawOptions: unknown, log: Log, proc: NapProcess, hooks: NapHooks = {}): () => void {
  type State = "starting" | "running" | "napping" | "off"
  let state: State = "starting"
  let timer: unknown
  const disposers: Array<() => void> = []

  const release = () => {
    if (timer !== undefined) proc.clearTimer(timer)
    timer = undefined
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Already turning off; nothing more to undo.
      }
    }
  }
  const off = (message: string, detail?: unknown) => {
    if (state === "off") return
    state = "off"
    log.once(message, detail)
    release()
  }
  const cleanup = () => {
    state = "off"
    release()
  }

  const parsed = parseOptions(rawOptions)
  if (!parsed.ok) {
    off("off: invalid options", { message: parsed.message })
    return cleanup
  }
  const options = parsed.options
  if (!options.enabled) {
    off("refused", { reason: "disabled in options" })
    return cleanup
  }

  const probed = probe(context, proc.stdin)
  if (!probed.ok) {
    off("off: missing OpenCode internal", { name: probed.missing })
    return cleanup
  }
  const { host, stdin } = probed

  const resolveDirectory = directoryResolver(proc.start)
  const pending = hooks.pending ?? createPendingWrites()

  let idle: IdleSource | undefined
  let focus: FocusSource | undefined

  const decideNow = () => {
    if (!idle || !focus) throw new Error("sources are not running")
    // While suspended, another program (an external editor) owns the terminal.
    const deferReasons = host.renderer.controlState === "explicit_suspended" ? [TERMINAL_HANDED_OFF] : []
    return decide({ now: proc.now(), lastInputAt: idle.lastInputAt(), ...focus.state(), deferReasons }, options)
  }

  const schedule = (ms: number) => {
    timer = proc.setTimer(tick, ms)
  }

  const nap = async (rule: string) => {
    state = "napping"
    let result
    try {
      const route = host.ui.router.current()
      result = await park({
        route,
        args: proc.args,
        resolveDirectory,
        opencodePath: proc.execPath,
        env: proc.env(),
        title: sessionID => host.data.session.get(sessionID)?.title,
        pending,
        beforeNap: hooks.beforeNap,
        stillDue: () => state === "napping" && decideNow().action === "nap",
        onExec: () => log.write("napping", { rule, route }),
        execve: proc.execve,
      })
    } catch (error) {
      off("off: runtime error", { error: describe(error) })
      return
    }
    if (state !== "napping") return
    if (result.status === "exec-failed") {
      off("off: exec failed", { error: describe(result.error) })
      return
    }
    log.once(`nap skipped: ${result.reason}`)
    state = "running"
    schedule(SKIP_RETRY_MS)
  }

  function tick() {
    timer = undefined
    if (state !== "running") return
    let decision
    try {
      decision = decideNow()
    } catch (error) {
      off("off: runtime error", { error: describe(error) })
      return
    }
    if (decision.action === "nap") {
      void nap(decision.rule)
      return
    }
    for (const reason of decision.deferred) log.once(`nap deferred: ${reason}`)
    schedule(decision.checkAfterMs)
  }

  void (async () => {
    let serverPid: number | undefined
    try {
      const info: unknown = await host.client.server.info()
      const pid = isRecord(info) ? info.pid : undefined
      serverPid = typeof pid === "number" && Number.isInteger(pid) ? pid : undefined
    } catch {
      // An unknown server pid is refused below.
    }
    if (state !== "starting") return

    const guard = checkGuards(proc.guardFacts(serverPid))
    if (!guard.ok) {
      off("refused", { reason: guard.reason })
      return
    }
    // The arguments never change, so a command line that cannot be rebuilt now never can.
    const args = buildWakeArgs(proc.args, { type: "other" })
    if (!args.ok) {
      off("refused", { reason: args.reason })
      return
    }

    try {
      const sources = {
        idle: createIdleSource({
          now: proc.now,
          readAtime: proc.readAtime,
          keyInput: host.renderer.keyInput,
          stdin,
        }),
        focus: createFocusSource({ renderer: host.renderer, now: proc.now }),
      }
      idle = sources.idle
      focus = sources.focus
      disposers.push(() => sources.idle.dispose(), () => sources.focus.dispose())
    } catch (error) {
      off("off: runtime error", { error: describe(error) })
      return
    }
    state = "running"
    log.write("watching", { serverPid })
    tick()
  })().catch(error => off("off: runtime error", { error: describe(error) }))

  return cleanup
}

function readAtime(): number | undefined {
  try {
    return fstatSync(0).atimeMs
  } catch {
    return undefined
  }
}

export function realProcess(): NapProcess {
  return {
    now: () => Date.now(),
    setTimer(run, ms) {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return timer
    },
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    args: process.argv.slice(2),
    execPath: process.execPath,
    env: () => process.env,
    start: { cwd: process.cwd(), pwd: process.env.PWD, sameDirectory },
    stdin: process.stdin,
    readAtime,
    guardFacts: collectGuardFacts,
    execve(file, argv, env) {
      // The guards have checked that it exists.
      process.execve!(file, argv, env)
    },
  }
}

// A plain definition rather than Plugin.define (an identity helper), so the
// packed plugin has no runtime dependency on @opencode/plugin.
const plugin = {
  id: "opencode-nap",
  setup(context) {
    let rawOptions: unknown
    try {
      rawOptions = context.options
    } catch {
      rawOptions = undefined
    }
    // Read from the raw options so there is a log even when they are invalid.
    const log = createLog(isRecord(rawOptions) ? rawOptions.debugLogFile : undefined)
    log.write("loaded", { options: rawOptions })
    try {
      return startNap(context, rawOptions, log, realProcess())
    } catch (error) {
      log.once("off: runtime error", { error: describe(error) })
      return () => {}
    }
  },
} satisfies Plugin.Definition

export default plugin
