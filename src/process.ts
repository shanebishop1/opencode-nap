import { fstatSync } from "node:fs"
import { homedir } from "node:os"
import { sameDirectory, type StartDirectory } from "./directory.js"
import { draftFiles, type DraftFiles } from "./draft-file.js"
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
  home: string
  /** The terminal's size in cells, or undefined when it cannot be read. */
  terminalSize(): { width: number; height: number } | undefined
  env(): NodeJS.ProcessEnv
  start: StartDirectory
  stdin: unknown
  readAtime(): number | undefined
  guardFacts(serverPid: number | undefined): GuardFacts
  execve: Execve
  drafts: DraftFiles
}

function readAtime(): number | undefined {
  try {
    return fstatSync(0).atimeMs
  } catch {
    return undefined
  }
}

function terminalSize(): { width: number; height: number } | undefined {
  const { columns, rows } = process.stdout
  return columns > 0 && rows > 0 ? { width: columns, height: rows } : undefined
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
    home: homedir(),
    terminalSize,
    env: () => process.env,
    start: { cwd: process.cwd(), pwd: process.env.PWD, sameDirectory },
    stdin: process.stdin,
    readAtime,
    guardFacts: collectGuardFacts,
    drafts: draftFiles(),
    execve(file, argv, env) {
      // The guards have checked that it exists.
      process.execve!(file, argv, env)
    },
  }
}
