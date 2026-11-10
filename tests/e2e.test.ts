import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "path"
import {
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  e2eEnabled,
  installedPackage,
  startServer,
  startTui,
  writeCliConfig,
  type Scratch,
} from "./e2e/harness.js"
import { readJsonLines, sleep, waitUntil } from "./e2e/nap-run.js"
import type { PtyProcess } from "./e2e/pty.js"

let scratch: Scratch
let server: { process: PtyProcess; url: string }

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion} loads the packed plugin in a real TUI`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterAll(cleanup, 60_000)

  it("loads the npm-installed package listed with options in cli.json", async () => {
    const debugLogFile = join(scratch.root, "nap.log")
    const options = { idleMinutes: 5, debugLogFile }
    await writeCliConfig(scratch, [{ package: installedPackage(scratch), options }])

    const sessionID = await createSession(scratch, server.url)
    const tui = await startTui(scratch, server.url, sessionID)

    const context = () => `TUI screen:\n${tui.text().slice(-3000)}\nserver:\n${server.process.text().slice(-2000)}`
    const entries = await waitUntil(async () => {
      const found = await readJsonLines(debugLogFile)
      return found.some(entry => entry.message === "loaded") ? found : undefined
    }, 60_000, `"loaded" in the debug log`, context)

    const loaded = entries.filter(entry => entry.message === "loaded")
    expect(loaded, context()).toHaveLength(1)
    expect(loaded[0].detail?.options, context()).toEqual(options)
    // Still running, and OpenCode did not report the plugin as failed.
    await sleep(1_000)
    expect(await Promise.race([tui.exited.then(() => "exited"), sleep(0).then(() => "running")]), context()).toBe("running")
    expect(tui.text(), context()).not.toContain("Plugin failed")
    await tui.stop()
  }, 120_000)
})

