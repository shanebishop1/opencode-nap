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
import { join, resolve } from "node:path"

/** Environment variable that hands the next draft's file path to the plugin. */
export const DRAFT_ENV = "OPENCODE_NAP_DRAFT_FILE"

const DAY_MS = 24 * 60 * 60 * 1000
const STALE_MS = 7 * DAY_MS
// Absent on Windows, where the file mode and symlink checks are weaker anyway.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

const currentUid = (): number | undefined => process.getuid?.()

const ownedByUser = (stat: Stats): boolean => {
  const uid = currentUid()
  return uid === undefined || stat.uid === uid
}

/**
 * Per-user directory for drafts. Drafts are short-lived and may hold private
 * text, so they live in a directory only the current user can enter.
 */
export function draftDir(tmp?: string): string {
  return join(tmp ?? tmpdir(), `opencode-nap-${currentUid() ?? "user"}`)
}

const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`draft directory is not a plain directory: ${dir}`)
  if (!ownedByUser(stat)) throw new Error(`draft directory is not owned by the current user: ${dir}`)
  chmodSync(dir, 0o700)
}

/**
 * Stores draft text in a new, owner-only file and returns its absolute path.
 * Empty text is not a draft and writes nothing. Errors never include the text.
 */
export function writeDraft(text: string, dir: string = draftDir()): string | undefined {
  if (text === "") return undefined
  ensurePrivateDir(dir)
  const path = resolve(dir, randomUUID())
  writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 })
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

/**
 * Reads a draft and deletes its file, so the text lives on disk only until the
 * plugin takes it. Refused or missing paths give undefined; a refused path is still unlinked.
 */
export function readAndDeleteDraft(path: string): string | undefined {
  const text = readRegularFile(path)
  try {
    unlinkSync(path)
  } catch {
    // Already gone or not removable; there is nothing more to do.
  }
  return text
}

/** Returns the draft path from the environment and removes the variable so it is used once. */
export function takeDraftPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env[DRAFT_ENV]
  delete env[DRAFT_ENV]
  return path || undefined
}

/**
 * Deletes draft files left behind by a crash, judged by modification time.
 * Returns how many were removed. Never throws; a missing directory counts as zero.
 */
export function cleanStaleDrafts(dir: string = draftDir(), now: number = Date.now(), maxAgeMs: number = STALE_MS): number {
  let removed = 0
  try {
    if (!lstatSync(dir).isDirectory()) return 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = join(dir, entry.name)
      try {
        if (now - lstatSync(file).mtimeMs > maxAgeMs) {
          unlinkSync(file)
          removed++
        }
      } catch {
        // Vanished or not removable; try the rest.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to clean.
  }
  return removed
}
