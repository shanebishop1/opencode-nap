import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { Plugin } from "@opencode/plugin/tui"
import plugin from "../src/tui.js"

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opencode-nap-tui-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const setup = (options: Record<string, unknown>) =>
  plugin.setup({ options } as unknown as Plugin.Context)

describe("tui plugin", () => {
  it("exports a definition with the opencode-nap id and a setup function", () => {
    expect(plugin.id).toBe("opencode-nap")
    expect(typeof plugin.setup).toBe("function")
  })

  it("logs that it loaded, with its options, to the debug log file", async () => {
    const debugLogFile = join(directory, "nap.log")
    const cleanup = setup({ enabled: true, debugLogFile })

    expect(typeof cleanup).toBe("function")
    expect(() => (cleanup as () => void)()).not.toThrow()
    const [line] = (await readFile(debugLogFile, "utf8")).trim().split("\n")
    expect(JSON.parse(line)).toMatchObject({ message: "loaded", detail: { options: { enabled: true, debugLogFile } } })
  })

  it("never writes to the terminal", () => {
    const spies = [
      spyOn(process.stdout, "write"),
      spyOn(process.stderr, "write"),
      spyOn(console, "log"),
      spyOn(console, "error"),
    ]
    try {
      setup({})
      setup({ debugLogFile: join(directory, "nap.log") })
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
