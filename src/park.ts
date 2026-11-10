import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { buildWakeArgs, type Route } from "./argv.js"
import { buildStubExec } from "./stub.js"

export type Execve = (file: string, argv: string[], env: NodeJS.ProcessEnv) => void

/** Where the TUI was started, read at plugin setup. */
export interface StartDirectory {
  /** The process's directory. OpenCode has already changed into its directory argument. */
  cwd: string
  /** The shell's logical directory at launch, when it was set. */
  pwd: string | undefined
  sameDirectory(a: string, b: string): boolean
}

export function sameDirectory(a: string, b: string): boolean {
  try {
    const left = statSync(a)
    const right = statSync(b)
    return left.isDirectory() && left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

/**
 * Makes a relative directory argument absolute. The stub runs in the
 * directory OpenCode changed into, so passing the argument as given would
 * resolve it a second time. The shell's logical path is kept when it names
 * the same directory, so a path through a symlink stays one; otherwise the
 * process's directory is used.
 */
export function directoryResolver(start: StartDirectory): (arg: string) => string {
  return arg => {
    if (isAbsolute(arg)) return arg
    if (start.pwd !== undefined && isAbsolute(start.pwd)) {
      const logical = resolve(start.pwd, arg)
      if (start.sameDirectory(logical, start.cwd)) return logical
    }
    return start.cwd
  }
}

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

/** The plugin's own storage writes, which must land before the process is replaced. */
export interface PendingWrites {
  track<T>(write: Promise<T>): Promise<T>
  settled(): Promise<void>
}

export function createPendingWrites(): PendingWrites {
  const pending = new Set<Promise<unknown>>()
  return {
    track(write) {
      pending.add(write)
      const forget = () => pending.delete(write)
      write.then(forget, forget)
      return write
    },
    async settled() {
      await Promise.allSettled([...pending])
    },
  }
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
  /** Runs last before the exec; returns extra environment for the woken TUI. */
  beforeNap?: () => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  /** Checked after every wait; false when input arrived meanwhile. */
  stillDue: () => boolean
  /** Called just before the exec. */
  onExec?: () => void
  execve: Execve
}

export type ParkResult =
  | { status: "skipped"; reason: string }
  | { status: "exec-failed"; error: unknown }

/** Replaces the process with the nap stub. Returns only when it did not. */
export async function park(input: ParkInput): Promise<ParkResult> {
  const route = toWakeRoute(input.route)
  const wake = buildWakeArgs(input.args, route, input.resolveDirectory)
  if (!wake.ok) return { status: "skipped", reason: `cannot build the wake command line: ${wake.reason}` }

  const title = route.type === "session" ? input.title(route.sessionID) : undefined
  const extraEnv = await input.beforeNap?.()
  await input.pending.settled()
  if (!input.stillDue()) return { status: "skipped", reason: "input arrived while preparing to nap" }

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
