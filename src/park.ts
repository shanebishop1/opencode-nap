import { buildWakeArgs, type Route } from "./argv.js"
import type { PendingWrites } from "./pending.js"
import { buildStubExec } from "./stub.js"

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
  /** The session's title for the nap card. */
  title: (sessionID: string) => unknown
  pending: PendingWrites
  /** Runs once the storage writes have landed; returns extra environment for the woken TUI, or a deferral. */
  beforeNap?: () => Promise<BeforeNapResult> | BeforeNapResult
  /** Checked after every wait; false when input arrived or the nap was deferred meanwhile. */
  stillDue: () => boolean
  /** Called just before the exec. */
  onExec?: () => void
  execve: Execve
}

export type BeforeNapResult = Record<string, string> | NapDeferral | undefined

export type ParkResult =
  | { status: "skipped"; reason: string }
  | { status: "exec-failed"; error: unknown }

/** Replaces the process with the nap stub. Returns only when it did not. */
export async function park(input: ParkInput): Promise<ParkResult> {
  const route = toWakeRoute(input.route)
  const wake = buildWakeArgs(input.args, route, input.resolveDirectory)
  if (!wake.ok) return { status: "skipped", reason: `cannot build the wake command line: ${wake.reason}` }

  const title = route.type === "session" ? input.title(route.sessionID) : undefined
  if (!(await input.pending.settled())) return { status: "skipped", reason: "the plugin's storage writes took too long" }
  const extraEnv = await input.beforeNap?.()
  if (extraEnv instanceof NapDeferral) return { status: "skipped", reason: extraEnv.reason }
  if (!input.stillDue()) return { status: "skipped", reason: "no longer due after waiting" }

  const stub = buildStubExec({
    cardTitle: typeof title === "string" ? title : undefined,
    opencodePath: input.opencodePath,
    args: wake.args,
  })
  input.onExec?.()
  try {
    input.execve(stub.file, stub.argv, { ...input.env, ...extraEnv })
  } catch (error) {
    return { status: "exec-failed", error }
  }
  return { status: "exec-failed", error: new Error("execve returned") }
}
