import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createLog } from "../src/log.js"

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opencode-nap-log-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const readLines = async (file: string) =>
  (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)

describe("diagnostics log", () => {
  it("appends one JSON line per message", async () => {
    const file = join(directory, "nap.log")
    const log = createLog(file)
    log.write("first", { reason: "test" })
    log.write("second")

    const lines = await readLines(file)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ message: "first", detail: { reason: "test" } })
    expect(lines[1]).toMatchObject({ message: "second" })
    expect(lines[1]).not.toHaveProperty("detail")
    expect(typeof lines[0].time).toBe("string")
  })

  it("writes a once message only the first time", async () => {
    const file = join(directory, "nap.log")
    const log = createLog(file)
    log.once("turned off", { reason: "a" })
    log.once("turned off", { reason: "b" })
    log.once("other")

    expect((await readLines(file)).map(line => line.message)).toEqual(["turned off", "other"])
  })

  it("writes nothing without an absolute debug log file", async () => {
    const cwd = process.cwd()
    process.chdir(directory)
    try {
      for (const file of [undefined, "", "relative.log", 42]) createLog(file).write("ignored")
    } finally {
      process.chdir(cwd)
    }
    expect(await readdir(directory)).toEqual([])
  })

  it("does not throw when the file cannot be written", () => {
    const log = createLog(join(directory, "missing", "nap.log"))
    expect(() => log.write("lost")).not.toThrow()
  })
})
