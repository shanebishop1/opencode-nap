export type Route = { type: "session"; sessionID: string } | { type: "other" }
export type WakeArgs = { ok: true; args: string[] } | { ok: false; reason: string }

// Startup flags that pick a session or start a prompt. A nap must never carry them into a wake.
const SESSION_FLAGS = new Set(["-s", "--session"])
const CONTINUE_FLAGS = new Set(["-c", "--continue"])
const PROMPT_FLAGS = new Set(["--prompt"])

// Startup flags a wake keeps. Values are passed as their own elements, never joined.
const KEPT_VALUE_FLAGS = new Set(["--server", "--log-level"])
const KEPT_FLAGS = new Set(["--auto", "--print-logs"])

// Subcommands from `opencode --help`. A positional naming one would not open the TUI.
const SUBCOMMANDS = new Set([
  "upgrade",
  "update",
  "uninstall",
  "acp",
  "api",
  "debug",
  "auth",
  "mcp",
  "plugin",
  "models",
  "stats",
  "mini",
  "run",
  "session",
  "service",
  "reload",
  "pair",
  "serve",
])

const refuse = (reason: string): WakeArgs => ({ ok: false, reason })

export function buildWakeArgs(args: string[], route: Route): WakeArgs {
  const kept: string[] = []
  let positionals = 0

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (!arg.startsWith("-")) {
      if (arg === "") return refuse("empty argument")
      if (SUBCOMMANDS.has(arg)) return refuse(`subcommand "${arg}" is not allowed`)
      positionals += 1
      if (positionals > 1) return refuse(`extra argument "${arg}"`)
      kept.push(arg)
      continue
    }

    // Short flags are exactly "-x"; "-s=value" and "-svalue" are not guessed at.
    if (!arg.startsWith("--") && arg.length !== 2) return refuse(`unknown argument "${arg}"`)

    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    if (SESSION_FLAGS.has(name) || PROMPT_FLAGS.has(name)) {
      if (inline === undefined) {
        if (i + 1 >= args.length) return refuse(`missing value for "${name}"`)
        // OpenCode may have read a dash-led value as a flag of its own, so
        // dropping it could also drop a flag the wake must keep.
        if (args[i + 1].startsWith("-")) return refuse(`ambiguous value for "${name}"`)
        i += 1
      }
      continue
    }

    if (CONTINUE_FLAGS.has(name) || KEPT_FLAGS.has(name)) {
      if (inline !== undefined) return refuse(`unknown argument "${arg}"`)
      if (KEPT_FLAGS.has(name)) kept.push(arg)
      continue
    }

    if (KEPT_VALUE_FLAGS.has(name)) {
      const value: string | undefined = inline ?? args[i + 1]
      if (value === undefined) return refuse(`missing value for "${name}"`)
      if (value === "" || value.startsWith("-")) return refuse(`invalid value for "${name}"`)
      kept.push(arg)
      if (inline === undefined) {
        kept.push(value)
        i += 1
      }
      continue
    }

    return refuse(`unknown argument "${arg}"`)
  }

  if (route.type === "session") {
    const { sessionID } = route
    if (sessionID === "" || sessionID.startsWith("-")) return refuse(`invalid session id "${sessionID}"`)
    kept.push("-s", sessionID)
  }

  return { ok: true, args: kept }
}
