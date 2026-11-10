import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { DRAFT_ENV, draftDir, draftFiles } from "../src/draft-file.js"

const DAY = 24 * 60 * 60 * 1000

let tmp = ""
let dir = ""

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "opencode-nap-draft-"))
  dir = join(tmp, "drafts")
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const save = (text: string, into = dir) => draftFiles({}, into).save(text)

/** Takes the draft at `path` the way a woken TUI does. */
const take = (path: string) => draftFiles({ [DRAFT_ENV]: path }, dir).take()

const mode = (path: string) => statSync(path).mode & 0o777

const messageOf = (action: () => unknown): string => {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to throw")
}

describe("draftFiles", () => {
  it("scopes the draft directory to the current user under the temp root", () => {
    const uid = process.getuid?.() ?? "user"
    expect(draftDir(tmp)).toBe(join(tmp, `opencode-nap-${uid}`))
  })

  it("ac-draft-file: hands a draft over in a private file and takes it once", () => {
    const path = save("one\ntwo ☃")
    const env: NodeJS.ProcessEnv = { [DRAFT_ENV]: path, PATH: "/usr/bin" }
    const woken = draftFiles(env, dir)
    expect(woken.take()).toBe("one\ntwo ☃")
    expect(existsSync(path)).toBe(false)
    expect(env).toEqual({ PATH: "/usr/bin" })
    expect(woken.take()).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")("keeps the draft directory 0700 and the draft file 0600", () => {
    const path = save("secret")
    expect(mode(dir)).toBe(0o700)
    expect(mode(path)).toBe(0o600)
  })

  it.skipIf(process.platform === "win32")("tightens an existing draft directory to 0700", () => {
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    save("secret")
    expect(mode(dir)).toBe(0o700)
  })

  it("ac-draft-large: keeps a 1 MB draft intact", () => {
    const text = "é🙂\n".repeat(150_000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024)
    expect(take(save(text))).toBe(text)
  })

  it("throws when the handed-over file cannot be read, and still removes the variable", () => {
    const env: NodeJS.ProcessEnv = { [DRAFT_ENV]: join(dir, "missing") }
    expect(() => draftFiles(env, dir).take()).toThrow("the draft file could not be read")
    expect(env[DRAFT_ENV]).toBeUndefined()
  })

  it("discards a stored draft", () => {
    const files = draftFiles({}, dir)
    const path = files.save("x")
    files.discard(path)
    files.discard(path)
    expect(existsSync(path)).toBe(false)
  })

  it("ac-draft-stale: deletes drafts older than seven days and keeps recent ones", () => {
    const now = Date.now()
    const stale = save("stale")
    const recent = save("recent")
    const fresh = save("fresh")
    utimesSync(stale, new Date(now - 8 * DAY), new Date(now - 8 * DAY))
    utimesSync(recent, new Date(now - 6 * DAY), new Date(now - 6 * DAY))

    draftFiles({}, dir).cleanStale()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it("cleans nothing when the draft directory is missing", () => {
    expect(() => draftFiles({}, dir).cleanStale()).not.toThrow()
  })

  it("neither reads nor deletes a path outside the draft directory", () => {
    mkdirSync(dir)
    const outside = join(tmp, "important.txt")
    writeFileSync(outside, "keep me")

    expect(() => take(outside)).toThrow()
    expect(() => take(`${dir}/../important.txt`)).toThrow()
    expect(readFileSync(outside, "utf8")).toBe("keep me")
  })

  it.skipIf(process.platform === "win32")("refuses a FIFO in place of the draft without hanging", () => {
    mkdirSync(dir)
    const fifo = join(dir, "fifo")
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0)

    expect(() => take(fifo)).toThrow()
    expect(existsSync(fifo)).toBe(false)
  })

  it.skipIf(process.platform === "win32")("refuses a symlinked draft directory", () => {
    const target = join(tmp, "target")
    mkdirSync(target)
    const link = join(tmp, "link")
    symlinkSync(target, link)

    expect(() => save("secret", link)).toThrow()
    expect(readdirSync(target)).toEqual([])
  })

  it.skipIf(process.platform === "win32")("refuses a symlinked draft path without reading its target", () => {
    mkdirSync(dir)
    const outside = join(tmp, "outside.txt")
    writeFileSync(outside, "secret")
    const link = join(dir, "link")
    symlinkSync(outside, link)

    expect(() => take(link)).toThrow()
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

    for (const into of [blocked, link]) {
      const message = messageOf(() => save(text, into))
      expect(message).not.toContain(text)
      expect(message).not.toContain("private draft")
    }
  })
})
