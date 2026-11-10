import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

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
