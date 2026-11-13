import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import {
  cleanup, cliVersion, createScratch, createSession, e2eEnabled, installedPackage,
  installObserver, startServer, startTuiWith, stopTuis, writeCliConfig, type Scratch,
} from "./e2e/harness.js"
import { NapRun, SPACE, waitUntil, Watch } from "./e2e/nap-run.js"
import { napOptions, NAP_TIMEOUT_MS } from "./e2e/timing.js"

const FOCUS_IN = "\x1b[I"
const FOCUS_OUT = "\x1b[O"

function focusReporting(raw: string): boolean {
  let on = false
  // eslint-disable-next-line no-control-regex
  for (const match of raw.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    if (match[1].split(";").includes("1004")) on = match[2] === "h"
  }
  return on
}

let scratch: Scratch
let server: Awaited<ReturnType<typeof startServer>>

/** Start the packed plugin only after the real renderer has received focus. */
async function openAfterFocus(name: string, report: string) {
  const watch = await Watch.configure(scratch, name, napOptions)
  const gate = join(scratch.root, `${name}-gate`)
  await mkdir(gate)
  await writeFile(join(gate, "package.json"), JSON.stringify({ name: "nap-e2e-focus-gate", private: true, type: "module", exports: { "./tui": "./tui.js" } }))
  await writeFile(join(gate, "tui.js"), `
    import nap from ${JSON.stringify(join(installedPackage(scratch), "dist/tui.js"))}
    import { appendFileSync } from "node:fs"
    export default { id: "nap-e2e-focus-gate", async setup(api) {
      if (!process.env.NAP_E2E_FOCUS_GATE_PASSED) {
        await new Promise(resolve => {
          const ready = () => { api.renderer.off(${JSON.stringify(report === FOCUS_OUT ? "blur" : "focus")}, ready); resolve() }
          api.renderer.on(${JSON.stringify(report === FOCUS_OUT ? "blur" : "focus")}, ready)
          appendFileSync(${JSON.stringify(watch.observerLog)}, JSON.stringify({event:"waiting-for-focus"}) + "\\n")
        })
        process.env.NAP_E2E_FOCUS_GATE_PASSED = "1"
      }
      return nap.setup(api)
    } }
  `)
  await writeCliConfig(scratch, [
    { package: gate, options: { ...napOptions, debugLogFile: watch.napLog } },
    { package: await installObserver(scratch), options: { logFile: watch.observerLog, controlDir: watch.controlDir } },
  ])
  const sessionID = await createSession(scratch, server.url)
  const tui = await startTuiWith(scratch, name, ["--server", server.url, "-s", sessionID, scratch.project])
  const run = new NapRun(tui, watch)
  await waitUntil(() => tui.output().includes("\x1b[?1004$p") || undefined, 60_000, "the focus mode query")
  tui.write("\x1b[?1004;2$y")
  await waitUntil(() => focusReporting(tui.output()) || undefined, 30_000, "focus reporting on")
  await waitUntil(async () => (await watch.observerEntries()).some(entry => entry.event === "waiting-for-focus") || undefined, 30_000, "delayed plugin setup")
  tui.write(report)
  await run.waitForWatching(1)
  await run.waitForInteractive(0)
  return { tui, run }
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: focus received before plugin setup`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)
  afterEach(stopTuis, 60_000)
  afterAll(cleanup, 60_000)

  it("ac-focus-startup: an already-unfocused window naps and wakes on refocus", async () => {
    const { tui, run } = await openAfterFocus("early-blur", FOCUS_OUT)
    await run.waitForNap(NAP_TIMEOUT_MS)
    expect(focusReporting(tui.output()), await run.context()).toBe(true)
    const focusAt = Date.now()
    tui.write(FOCUS_IN)
    await run.waitForWatching(2)
    await run.waitForInteractive(focusAt)
  }, 120_000)

  it("ac-focus-startup: an already-focused window still waits for a key or click", async () => {
    const { tui, run } = await openAfterFocus("early-focus", FOCUS_IN)
    await run.waitForNap(NAP_TIMEOUT_MS)
    // A real terminal sends no focus reports while this mode is disabled.
    expect(focusReporting(tui.output()), await run.context()).toBe(false)
    await run.assertNapping()
    const spaceAt = await run.wake(SPACE)
    await run.waitForWatching(2)
    await run.waitForInteractive(spaceAt)
  }, 120_000)
})
