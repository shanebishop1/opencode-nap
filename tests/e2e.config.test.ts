import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import {
  cleanup, cliVersion, createScratch, createSession, e2eEnabled, installedPackage,
  startServer, startTuiWith, stopTuis, writeCliConfig, writeServerConfig, type Scratch,
} from "./e2e/harness.js"
import { CARD, readJsonLines } from "./e2e/nap-run.js"
import { processTree } from "./e2e/processes.js"
import type { PtyProcess } from "./e2e/pty.js"
import { napOptions } from "./e2e/timing.js"

let scratch: Scratch
let server: { process: PtyProcess; url: string } | undefined

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: opencode.json configuration`, () => {
  beforeAll(async () => { scratch = await createScratch() }, 300_000)
  afterEach(async () => {
    await stopTuis()
    await server?.process.stop()
    server = undefined
    await rm(join(scratch.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), { force: true })
  }, 60_000)
  afterAll(cleanup, 60_000)

  for (const source of ["project", "global", "both", "override"] as const) {
    it(`applies ${source} options with one watcher per window`, async () => {
      const debugLogFile = join(scratch.root, `${source}.nap.jsonl`)
      const options = { ...napOptions, debugLogFile }
      const entry = { package: installedPackage(scratch), options }
      await writeCliConfig(scratch, source === "both" ? [installedPackage(scratch)] : source === "override" ? [entry] : [])
      const serverEntry = source === "override" ? { ...entry, options: { enabled: false } } : entry
      await writeServerConfig(scratch, { enabled_providers: [], plugins: source === "global" ? [] : [serverEntry] })
      if (source === "global") {
        const directory = join(scratch.env.XDG_CONFIG_HOME, "opencode")
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [entry], enabled_providers: [] }))
      }
      server = await startServer(scratch, `${source}-server`)
      const sessionID = await createSession(scratch, server.url)
      const tui = await startTuiWith(scratch, source, ["--server", server.url, "-s", sessionID, scratch.project])
      await tui.waitFor(CARD, 45_000)
      expect((await processTree(tui.pid)).leader).toStartWith("sh -c ")
      expect((await readJsonLines(debugLogFile)).map(entry => entry.message)).toEqual(["loaded", "watching", "napping"])
      expect(tui.text()).not.toContain("Plugin failed")
    }, 120_000)
  }
})
