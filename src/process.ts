import { fstatSync } from "node:fs"
import { sameDirectory, type StartDirectory } from "./directory.js"
import { collectGuardFacts, type GuardFacts } from "./guards.js"
import type { Execve } from "./park.js"

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
