import { accessSync, constants } from "node:fs"
import { isMainThread } from "node:worker_threads"

export interface GuardFacts {
  platform: string
  hasExecve: boolean
  isMainThread: boolean
  args: string[]
  pid: number
  serverPid: number | undefined
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  shExecutable: boolean
  enabled: boolean
}

export type GuardResult = { ok: true } | { ok: false; reason: string }

const pass: GuardResult = { ok: true }

const refuse = (reason: string): GuardResult => ({ ok: false, reason })

const isStandaloneFlag = (arg: string) => arg === "--standalone" || arg.startsWith("--standalone=")

export function checkGuards(facts: GuardFacts): GuardResult {
  if (!facts.enabled) return refuse("disabled in options")
  if (facts.platform === "win32") return refuse("Windows is not supported")
  if (!facts.hasExecve) return refuse("process.execve is not available")
  if (!facts.isMainThread) return refuse("not on the main thread")
  if (facts.args.some(isStandaloneFlag)) return refuse("started with --standalone: the server runs in this process")
  if (facts.serverPid === facts.pid) return refuse("the server runs in this process")
  if (!facts.stdinIsTTY || !facts.stdoutIsTTY) return refuse("stdin and stdout must be a terminal")
  if (!facts.shExecutable) return refuse("/bin/sh is not executable")
  return pass
}

// Reads the real process. An unreadable fact takes the unsafe value so the
// matching guard refuses instead of the read throwing.
function readOr<T>(read: () => T, unsafe: T): T {
  try {
    return read()
  } catch {
    return unsafe
  }
}

function isShExecutable(platform: string): boolean {
  // POSIX-only path; Windows is refused before this result matters.
  if (platform === "win32") return false
  return readOr(() => {
    accessSync("/bin/sh", constants.X_OK)
    return true
  }, false)
}

export function collectGuardFacts(input: { enabled: boolean; serverPid: number | undefined }): GuardFacts {
  const platform = readOr(() => process.platform, "unknown")
  // An unreadable pid is treated as the server's pid when that is known.
  const pid = readOr(() => process.pid, input.serverPid ?? -1)
  return {
    platform,
    hasExecve: readOr(() => typeof process.execve === "function", false),
    isMainThread: readOr(() => isMainThread, false),
    // An unreadable argv could hide --standalone, so assume it is present.
    args: readOr(() => process.argv.slice(2), ["--standalone"]),
    pid,
    serverPid: input.serverPid,
    stdinIsTTY: readOr(() => process.stdin.isTTY === true, false),
    stdoutIsTTY: readOr(() => process.stdout.isTTY === true, false),
    shExecutable: isShExecutable(platform),
    enabled: input.enabled,
  }
}
