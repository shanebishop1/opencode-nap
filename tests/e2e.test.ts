import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"
import {
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  installedPackage,
  startServer,
  startTui,
  writeCliConfig,
  type Scratch,
} from "./e2e/harness.js"
import type { PtyProcess } from "./e2e/pty.js"

const enabled = process.env.NAP_E2E === "1"

let scratch: Scratch | undefined
let server: { process: PtyProcess; url: string } | undefined

const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))

const readLog = async (file: string): Promise<Array<{ message?: string; detail?: { options?: unknown } }>> => {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

describe.skipIf(!enabled)(`OpenCode ${cliVersion} loads the packed plugin in a real TUI`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterAll(async () => {
    const survivors = await cleanup()
    if (survivors.length) throw new Error(`processes outlived the test and were killed:\n${survivors.join("\n")}`)
  }, 60_000)

  it("loads the npm-installed package listed with options in cli.json", async () => {
    if (!scratch || !server) throw new Error("setup failed")
    const debugLogFile = join(scratch.root, "nap.log")
    const options = { idleMinutes: 0.25, marker: `e2e-${Date.now()}`, debugLogFile }
    await writeCliConfig(scratch, [{ package: installedPackage(scratch), options }])

    const sessionID = await createSession(scratch, server.url)
    const tui = await startTui(scratch, server.url, sessionID)

    const deadline = Date.now() + 60_000
    let entries = await readLog(debugLogFile)
    while (!entries.some(entry => entry.message === "loaded") && Date.now() < deadline) {
      await sleep(200)
      entries = await readLog(debugLogFile)
    }
    const context = `TUI screen:\n${tui.text().slice(-3000)}\nserver:\n${server.process.text().slice(-2000)}`

    const loaded = entries.filter(entry => entry.message === "loaded")
    expect(loaded, context).toHaveLength(1)
    expect(loaded[0].detail?.options, context).toEqual(options)
    // Still running, and OpenCode did not report the plugin as failed.
    await sleep(1_000)
    expect(await Promise.race([tui.exited.then(() => "exited"), sleep(0).then(() => "running")]), context).toBe("running")
    expect(tui.text(), context).not.toContain("Plugin failed")
  }, 120_000)
})
