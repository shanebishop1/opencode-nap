import type { Plugin } from "@opencode/plugin/tui"
import { buildWakeArgs } from "./argv.js"
import { parseOptions } from "./config.js"
import { directoryResolver } from "./directory.js"
import { createDraftCarry, restoreDraft, type DraftRestore } from "./draft.js"
import { createFocusSource, type FocusSource } from "./focus.js"
import { checkGuards } from "./guards.js"
import { hostCard } from "./host-card.js"
import { createIdleSource, type IdleSource } from "./idle.js"
import { createLog, type Log } from "./log.js"
import { park } from "./park.js"
import { pluginOptions } from "./plugin-options.js"
import { decide } from "./policy.js"
import { probe } from "./probe.js"
import { probePrompt } from "./prompt.js"
import { realProcess, type NapProcess } from "./process.js"

// How soon to try again after a nap was skipped at nap time.
const SKIP_RETRY_MS = 5_000

const TERMINAL_HANDED_OFF = "the terminal is handed to another program"

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const rendererOf = (context: unknown): unknown => {
  try {
    return isRecord(context) ? context.renderer : undefined
  } catch {
    return undefined
  }
}

/** Restores the draft of the nap that started this TUI, whatever the options say now: it is the user's text. */
function restoreHandedOverDraft(context: unknown, proc: NapProcess, log: Log): DraftRestore | undefined {
  try {
    const text = proc.drafts.take()
    return text === undefined ? undefined : restoreDraft({ text, renderer: rendererOf(context), log })
  } catch {
    log.once("draft not restored", { reason: "the handed-over draft could not be restored" })
    return undefined
  }
}

/**
 * Runs the plugin for one TUI and returns its cleanup. Every way of turning
 * off writes one log line and leaves the TUI as it was.
 */
export function startNap(context: unknown, rawOptions: unknown, log: Log, proc: NapProcess): () => void {
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
  // First, so the hand-over variable is gone however the plugin turns out.
  const restore = restoreHandedOverDraft(context, proc, log)
  const cleanup = () => {
    state = "off"
    restore?.stop()
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
  try {
    proc.drafts.cleanStale()
  } catch {
    // Left for the next start.
  }

  const probed = probe(context, proc.stdin)
  if (!probed.ok) {
    off("off: missing OpenCode internal", { name: probed.missing })
    return cleanup
  }
  const { host, stdin } = probed

  const carry = options.carryDraft ? createDraftCarry({ renderer: host.renderer, files: proc.drafts, unrestored: () => restore?.unrestored() }) : undefined
  if (carry) {
    const missing = probePrompt(host.renderer)
    // Not a reason to turn off: each nap is skipped until the draft can be read.
    if (missing) log.once("draft unavailable: missing OpenCode internal", { name: missing })
    disposers.push(() => carry.dispose())
  }

  const resolveDirectory = directoryResolver(proc.start)

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

  const nap = (rule: string) => {
    state = "napping"
    let result
    try {
      const route = host.ui.router.current()
      result = park({
        route,
        args: proc.args,
        resolveDirectory,
        opencodePath: proc.execPath,
        env: proc.env(),
        session: sessionID => {
          const session = host.data.session.get(sessionID)
          return { title: session?.title, directory: session?.location?.directory }
        },
        card: session => hostCard(context, proc, session),
        // Coming back wakes a window that napped because you left it; the
        // idle timer's nap still waits for a key or click.
        wakeOnFocus: rule !== "idle",
        beforeNap: () => carry?.capture(),
        stillDue: () => state === "napping" && decideNow().action === "nap",
        onExec: route => log.write("napping", { rule, route }),
        execve: proc.execve,
      })
    } catch (error) {
      off("off: runtime error", { error: describe(error) })
      return
    } finally {
      // Still here, so the draft was never handed over.
      carry?.discard()
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

  // A focus change can make a rule due before the next check. Check on the
  // next turn, not at once: the renderer reports focus while handling the
  // input chunk, before the idle source has seen it, so checking now would
  // count the chunk's access-time bump as input.
  function recheck() {
    if (state !== "running") return
    if (timer !== undefined) proc.clearTimer(timer)
    schedule(0)
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
      nap(decision.rule)
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
        focus: createFocusSource({ renderer: host.renderer, now: proc.now, onChange: recheck }),
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

// A plain definition rather than Plugin.define (an identity helper), so the
// packed plugin has no runtime dependency on @opencode/plugin.
const plugin = {
  id: "opencode-nap",
  async setup(context) {
    let rawOptions: unknown
    let debugLogFile: unknown
    try {
      rawOptions = await pluginOptions(context)
      debugLogFile = isRecord(rawOptions) ? rawOptions.debugLogFile : undefined
    } catch {
      // Unreadable options could hide enabled: false; never guess defaults.
      return () => {}
    }
    // Read from the raw options so there is a log even when they are invalid.
    const log = createLog(debugLogFile)
    log.write("loaded")
    try {
      return startNap(context, rawOptions, log, realProcess())
    } catch (error) {
      log.once("off: runtime error", { error: describe(error) })
      return () => {}
    }
  },
} satisfies Plugin.Definition

export default plugin
