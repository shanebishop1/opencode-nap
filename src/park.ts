import { buildWakeArgs, type Route } from "./argv.js"
import { dropAddedServer, namesServer, serviceFile } from "./service.js"
import { buildStubExec } from "./stub.js"
import { fallbackTerminalTitle } from "./terminal-title.js"

export type Execve = (file: string, argv: string[], env: NodeJS.ProcessEnv) => void

/** Reads OpenCode's route. Throws when its shape is not the expected one. */
export function toWakeRoute(route: unknown): Route {
  if (typeof route !== "object" || route === null || typeof (route as { type?: unknown }).type !== "string") {
    throw new Error("unexpected route shape")
  }
  const { type, sessionID } = route as { type: string; sessionID?: unknown }
  if (type !== "session") return { type: "other" }
  if (typeof sessionID !== "string") throw new Error("session route without a session id")
  return { type: "session", sessionID }
}

/** What the nap card shows of the session. */
export interface SessionFacts {
  title?: unknown
  directory?: unknown
}

/** Returned by beforeNap to skip this nap; the plugin tries again later. */
export class NapDeferral {
  constructor(readonly reason: string) {}
}

export interface ParkInput {
  route: unknown
  args: string[]
  resolveDirectory: (arg: string) => string
  opencodePath: string
  env: NodeJS.ProcessEnv
  /** The user's home directory, for the default service registration. */
  home: string
  /** The version of the server this window is attached to, when known. */
  serverVersion?: string
  session: (sessionID: string) => SessionFacts
  /** The last live title, or an empty string when title updates are disabled. */
  terminalTitle?: string
  /** Builds the nap screen the stub prints. */
  card: (session: SessionFacts) => string
  /** Whether regaining focus wakes the nap, as well as a key or click. */
  wakeOnFocus: boolean
  /** Synchronously saves the draft; returns extra environment for the woken TUI, or a deferral. */
  beforeNap?: () => Record<string, string> | NapDeferral | undefined
  /** Checked after draft capture, in case input arrived since the nap was decided. */
  stillDue: () => boolean
  /** Called just before the exec. */
  onExec?: (route: Route) => void
  execve: Execve
}

export type ParkResult =
  | { status: "skipped"; reason: string }
  | { status: "exec-failed"; error: unknown }

/** Replaces the process with the nap stub. Returns only when it did not. */
export function park(input: ParkInput): ParkResult {
  const route = toWakeRoute(input.route)
  // A --server the last wake added is dropped, so this wake reads the
  // service registration again instead of keeping a URL that may be stale.
  const started = dropAddedServer(input.args, input.env)
  const wake = buildWakeArgs(started.args, route, input.resolveDirectory)
  if (!wake.ok) return { status: "skipped", reason: `cannot build the wake command line: ${wake.reason}` }

  const session = route.type === "session" ? input.session(route.sessionID) : {}
  const extraEnv = input.beforeNap?.()
  if (extraEnv instanceof NapDeferral) return { status: "skipped", reason: extraEnv.reason }
  if (!input.stillDue()) return { status: "skipped", reason: "no longer due before exec" }

  const stub = buildStubExec({
    card: input.card(session),
    terminalTitle: input.terminalTitle ?? fallbackTerminalTitle(input.route, session.title),
    wakeOnFocus: input.wakeOnFocus,
    opencodePath: input.opencodePath,
    service: !namesServer(wake.args) && input.serverVersion
      ? { file: serviceFile(started.env, input.home), version: input.serverVersion }
      : undefined,
    args: wake.args,
  })
  input.onExec?.(route)
  try {
    input.execve(stub.file, stub.argv, { ...started.env, ...extraEnv })
  } catch (error) {
    return { status: "exec-failed", error }
  }
  return { status: "exec-failed", error: new Error("execve returned") }
}
