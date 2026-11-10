import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { cleanStaleDrafts, DRAFT_ENV, draftDir, readAndDeleteDraft, takeDraftPath, writeDraft } from "../src/draft-file.js"

const DAY = 24 * 60 * 60 * 1000

let tmp = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-draft-"))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const write = (text: string, dir: string): string => {
  const path = writeDraft(text, dir)
  if (!path) throw new Error("expected a draft path")
  return path
}

const mode = (path: string) => statSync(path).mode & 0o777

const messageOf = (action: () => unknown): string => {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to throw")
}

describe("draft file", () => {
  it("scopes the draft directory to the current user under the temp root", () => {
    const uid = process.getuid?.() ?? "user"
    expect(draftDir(tmp)).toBe(join(tmp, `opencode-nap-${uid}`))
  })

  it("round-trips multi-line and non-ASCII text", () => {
    const text = "first line\nsecond line — ünïcödé 🙂\n"
    const path = write(text, join(tmp, "drafts"))
    expect(readAndDeleteDraft(path)).toBe(text)
  })

  it.skipIf(process.platform === "win32")("keeps the draft directory 0700 and the draft file 0600", () => {
    const dir = join(tmp, "drafts")
    const path = write("secret", dir)
    expect(mode(dir)).toBe(0o700)
    expect(mode(path)).toBe(0o600)
  })

  it("deletes the draft when it is read", () => {
    const path = write("once", join(tmp, "drafts"))
    expect(readAndDeleteDraft(path)).toBe("once")
    expect(existsSync(path)).toBe(false)
    expect(readAndDeleteDraft(path)).toBeUndefined()
  })

  it("writes nothing for empty text", () => {
    const dir = join(tmp, "drafts")
    expect(writeDraft("", dir)).toBeUndefined()
    expect(existsSync(dir)).toBe(false)
  })

  it("keeps a 1 MB draft intact", () => {
    const text = "é🙂\n".repeat(150_000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024)
    const path = write(text, join(tmp, "drafts"))
    expect(readAndDeleteDraft(path)).toBe(text)
  })

  it("takes the draft path from the environment and removes the variable", () => {
    const env: NodeJS.ProcessEnv = { [DRAFT_ENV]: "/tmp/draft" }
    expect(takeDraftPath(env)).toBe("/tmp/draft")
    expect(DRAFT_ENV in env).toBe(false)
    expect(takeDraftPath(env)).toBeUndefined()
  })

  it("deletes drafts older than seven days and keeps recent ones", () => {
    const dir = join(tmp, "drafts")
    const now = Date.now()
    const stale = write("stale", dir)
    const recent = write("recent", dir)
    const fresh = write("fresh", dir)
    utimesSync(stale, new Date(now - 8 * DAY), new Date(now - 8 * DAY))
    utimesSync(recent, new Date(now - 6 * DAY), new Date(now - 6 * DAY))

    expect(cleanStaleDrafts(dir, now)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it("returns zero when the stale-draft directory is missing", () => {
    expect(cleanStaleDrafts(join(tmp, "missing"))).toBe(0)
  })

  it.skipIf(process.platform === "win32")("refuses a symlinked draft directory", () => {
    const target = join(tmp, "target")
    mkdirSync(target)
    const link = join(tmp, "link")
    symlinkSync(target, link)

    expect(() => writeDraft("secret", link)).toThrow()
    expect(readdirSync(target)).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses a symlinked draft path without reading its target", () => {
    const dir = join(tmp, "drafts")
    mkdirSync(dir)
    const outside = join(tmp, "outside.txt")
    writeFileSync(outside, "secret")
    const link = join(dir, "link")
    symlinkSync(outside, link)

    expect(readAndDeleteDraft(link)).toBeUndefined()
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(outside, "utf8")).toBe("secret")
  })

  it.skipIf(process.platform === "win32")("keeps draft text out of error messages", () => {
    const text = "private draft ünïcode"
    const blocked = join(tmp, "blocked")
    writeFileSync(blocked, "not a directory")
    const target = join(tmp, "target")
    mkdirSync(target)
    const link = join(tmp, "link")
    symlinkSync(target, link)

    for (const dir of [blocked, link]) {
      const message = messageOf(() => writeDraft(text, dir))
      expect(message).not.toContain(text)
      expect(message).not.toContain("private draft")
    }
  })
})
