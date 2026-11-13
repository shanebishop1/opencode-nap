import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { napCard, plainCard } from "../src/card.js"
import { buildStubExec } from "../src/stub.js"
import {
  cleanup, cliVersion, createScratch, createSession, e2eEnabled, startCommand, startServer, startTuiWith, stopTuis, type Scratch,
} from "./e2e/harness.js"
import { NapRun, SPACE, stripEscapesSince, waitUntil, Watch } from "./e2e/nap-run.js"
import { processTree } from "./e2e/processes.js"
import { stripEscapes, type PtyProcess } from "./e2e/pty.js"
import { napOptions, NAP_TIMEOUT_MS } from "./e2e/timing.js"

// A pair of stubs that differ only in their card must differ by about a page:
// the shell that prints the card replaces itself before it waits for a key.
const RSS_BUDGET_KIB = 64
// What the window as a whole may hold while napping, as in the core test.
const NAPPED_LEADER_KIB = 5 * 1024

let scratch: Scratch
let server: { process: PtyProcess; url: string }

/** The shell's resident memory once a stub with this card is napping, started like the others in this run. */
async function stubRss(name: string, card: string): Promise<number> {
  const stub = buildStubExec({ card, wakeOnFocus: false, opencodePath: "/bin/true", args: [] })
  const pty = await startCommand(scratch, name, [stub.file, ...stub.argv.slice(1)])
  await waitUntil(() => (pty.output().includes("\x1b[?1000h") ? true : undefined), 10_000, `the ${name} stub to wait for a key`)
  await waitUntil(async () => ((await processTree(pty.pid)).count >= 2 ? true : undefined), 5_000, `the ${name} stub's reader`)
  await Bun.sleep(500)
  return (await processTree(pty.pid)).leaderRssKiB
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: the nap card`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("shows the logo and message and costs the napping shell no memory", async () => {
    const watch = await Watch.configure(scratch, "card", napOptions)
    const sessionID = await createSession(scratch, server.url)
    const tui = await startTuiWith(scratch, "card", ["--server", server.url, "-s", sessionID, scratch.project])
    const run = new NapRun(tui, watch)
    await run.waitForWatching(1)

    const napped = await run.waitForNap(NAP_TIMEOUT_MS)
    const drawn = stripEscapes(tui.output().slice(tui.output().lastIndexOf("\x1b[2J")))
    expect(drawn, await run.context()).toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█")
    expect(drawn).toContain("Napping to save memory. Press any key or click to wake.")
    expect(drawn).toContain("Sessions keep running in the background.")
    // Long scratch paths are cut to their last segments, so only the end is certain.
    expect(drawn).toContain("/project")
    expect(drawn).toContain(cliVersion)
    // The stub prints once and waits: one shell and its reader, nothing else,
    // and the shell that waits no longer carries the card.
    expect(napped.count).toBe(2)
    expect((await processTree(tui.pid)).leader).not.toContain("█")

    await Bun.sleep(1_000)
    expect((await processTree(tui.pid)).leaderRssKiB, await run.context()).toBeLessThan(NAPPED_LEADER_KIB)
    // The window's own card, against the 0.1.1 plain text, in one environment.
    const rich = napCard({
      size: { width: 120, height: 40 },
      palette: undefined,
      title: "Fix the flaky test",
      directory: scratch.project,
      home: scratch.env.HOME,
      version: cliVersion,
    })
    const [withCard, plain] = [await stubRss("card-stub", rich), await stubRss("plain-stub", plainCard(""))]
    console.log(`napped sh RSS: ${withCard} KiB with the card, ${plain} KiB with plain text (${withCard - plain} KiB more)`)
    expect(withCard - plain).toBeLessThan(RSS_BUDGET_KIB)

    const offset = tui.output().length
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    // The card's colours, hidden cursor and screen are cleared before OpenCode starts.
    expect(tui.output().slice(offset)).toContain("\x1b[0m\x1b[?25h\x1b[2J\x1b[H")
    expect(stripEscapesSince(tui, offset)).not.toContain("Press any key or click to wake.")
  }, 180_000)
})
