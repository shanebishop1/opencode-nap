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

  it("loads the npm-installed package and applies options from cli.json", async () => {
    const debugLogFile = join(scratch.root, "nap.log")
    const options = { enabled: false, debugLogFile }
    await writeCliConfig(scratch, [{ package: installedPackage(scratch), options }])

    const sessionID = await createSession(scratch, server.url)
    const tui = await startTui(scratch, server.url, sessionID)

    const context = () => `TUI screen:\n${tui.text().slice(-3000)}\nserver:\n${server.process.text().slice(-2000)}`
    const entries = await waitUntil(async () => {
      const found = await readJsonLines(debugLogFile)
      const loaded = found.some(entry => entry.message === "loaded")
      const disabled = found.some(entry => entry.message === "refused" && entry.detail?.reason === "disabled in options")
      return loaded && disabled ? found : undefined
    }, 60_000, `"loaded" and "disabled in options" in the debug log`, context)

    const loaded = entries.filter(entry => entry.message === "loaded")
    expect(loaded, context()).toHaveLength(1)
    const refused = entries.filter(entry => entry.message === "refused")
    expect(refused.map(entry => entry.detail?.reason), context()).toEqual(["disabled in options"])
    // Still running, and OpenCode did not report the plugin as failed.
    await sleep(1_000)
    expect(await Promise.race([tui.exited.then(() => "exited"), sleep(0).then(() => "running")]), context()).toBe("running")
    expect(tui.text(), context()).not.toContain("Plugin failed")
    await tui.stop()
  }, 120_000)
})
