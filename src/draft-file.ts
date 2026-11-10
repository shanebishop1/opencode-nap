import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Environment variable that hands the next draft's file path to the plugin. */
export const DRAFT_ENV = "OPENCODE_NAP_DRAFT_FILE"

const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Absent on Windows, where the file mode and symlink checks are weaker anyway.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

const currentUid = (): number | undefined => process.getuid?.()

const ownedByUser = (stat: Stats): boolean => {
  const uid = currentUid()
  return uid === undefined || stat.uid === uid
}

const isUserDir = (dir: string): boolean => {
  const stat = lstatSync(dir, { throwIfNoEntry: false })
  return stat !== undefined && stat.isDirectory() && ownedByUser(stat)
}

/**
 * Per-user directory for drafts. Drafts are short-lived and may hold private
 * text, so they live in a directory only the current user can enter.
 */
export function draftDir(tmp: string = tmpdir()): string {
  return join(tmp, `opencode-nap-${currentUid() ?? "user"}`)
}

const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`draft directory is not a plain directory: ${dir}`)
  if (!ownedByUser(stat)) throw new Error(`draft directory is not owned by the current user: ${dir}`)
  chmodSync(dir, 0o700)
}

// Errors never include the text.
const writeDraft = (text: string, dir: string): string => {
  ensurePrivateDir(dir)
  const path = resolve(dir, randomUUID())
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, text, "utf8")
  } catch (error) {
    // A failed write must not leave part of the draft on disk.
    unlinkSync(path)
    throw error
  } finally {
    closeSync(fd)
  }
  return path
}

/** Reads a regular, user-owned file without following symlinks; undefined when refused. */
const readRegularFile = (path: string): string | undefined => {
  let fd: number | undefined
  try {
    // O_NOFOLLOW refuses a symlink in place of the draft; O_NONBLOCK stops a FIFO from hanging the open.
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || !ownedByUser(stat)) return undefined
    return readFileSync(fd, "utf8")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const unlinkIfPresent = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // Already gone or not removable; there is nothing more to do.
  }
}

/**
 * Reads a draft and deletes its file, so the text lives on disk only until the
 * plugin takes it. A refused path inside the draft directory is still deleted;
 * a path anywhere else is left alone.
 */
const readAndDeleteDraft = (path: string, dir: string): string | undefined => {
  if (dirname(resolve(path)) !== resolve(dir) || !isUserDir(dir)) return undefined
  const text = readRegularFile(path)
  unlinkIfPresent(path)
  return text
}

const cleanStaleDrafts = (dir: string): void => {
  if (!isUserDir(dir)) return
  const now = Date.now()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(dir, entry.name)
    try {
      if (now - lstatSync(file).mtimeMs > STALE_MS) unlinkSync(file)
    } catch {
      // Vanished or not removable; try the rest.
    }
  }
}

/** Draft files, injected so tests can keep them out of the real temp directory and environment. */
export interface DraftFiles {
  /**
   * Takes the draft left by the nap that started this TUI and deletes its file
   * and the hand-over variable. Undefined when there was none; throws when the
   * file could not be read.
   */
  take(): string | undefined
  /** Stores a draft in a new, owner-only file and returns its path. */
  save(text: string): string
  /** Deletes a stored draft that was never handed over. */
  discard(path: string): void
  /** Deletes draft files older than 7 days, left by naps that never woke. Throws when the directory cannot be read. */
  cleanStale(): void
}

export function draftFiles(env: NodeJS.ProcessEnv = process.env, dir: string = draftDir()): DraftFiles {
  return {
    take() {
      const path = env[DRAFT_ENV]
      delete env[DRAFT_ENV]
      if (!path) return undefined
      const text = readAndDeleteDraft(path, dir)
      if (text === undefined) throw new Error("the draft file could not be read")
      return text
    },
    save: text => writeDraft(text, dir),
    discard: unlinkIfPresent,
    cleanStale: () => cleanStaleDrafts(dir),
  }
}
