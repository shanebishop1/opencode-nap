import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { plainCard } from "../src/card.js"
import { buildStubExec } from "../src/stub.js"
import {
  cleanup, cliVersion, createScratch, createSession, e2eEnabled, startCommand, startServer, startTuiWith, stopTuis, type Scratch,
} from "./e2e/harness.js"
import { NapRun, SPACE, stripEscapesSince, waitUntil, Watch } from "./e2e/nap-run.js"
import { processTree } from "./e2e/processes.js"
import { stripEscapes, type PtyProcess } from "./e2e/pty.js"

const napOptions = { idleMinutes: 0.25 }
const NAP_TIMEOUT_MS = 40_000
// The printed card is a few KB of argument that dash copies once to print.
// Two plain stubs differ by far less than this, so a card that cost a loop,
// buffer or child process would show.
const RSS_BUDGET_KIB = 64

let scratch: Scratch
let server: { process: PtyProcess; url: string }

/** A plain stub, as 0.1.1 ran, napping next to the TUI in the same environment. */
async function plainStubRss(): Promise<number> {
  const stub = buildStubExec({ card: plainCard(""), opencodePath: "/bin/true", args: [] })
  const pty = await startCommand(scratch, "plain-stub", [stub.file, ...stub.argv.slice(1)])
  await pty.waitFor(/Press any key or click to wake/, 10_000)
  const tree = await waitUntil(async () => {
    const found = await processTree(pty.pid)
    return found.count >= 2 ? found : undefined
  }, 5_000, "the plain stub and its reader")
  return tree.leaderRssKiB
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: the nap card`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("looks like the home screen and costs the napping shell no memory", async () => {
    const watch = await Watch.configure(scratch, "card", napOptions)
    const sessionID = await createSession(scratch, server.url)
    const tui = await startTuiWith(scratch, "card", ["--server", server.url, "-s", sessionID, scratch.project])
    const run = new NapRun(tui, watch)
    await run.waitForWatching(1)

    const napped = await run.waitForNap(NAP_TIMEOUT_MS)
    const drawn = stripEscapes(tui.output().slice(tui.output().lastIndexOf("\x1b[2J")))
    expect(drawn, await run.context()).toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█")
    expect(drawn).toContain("Napping… press any key or click to wake")
    expect(drawn).toContain("Napping · ")
    expect(drawn).toContain("work keeps running")
    // Long scratch paths are cut to their last segments, so only the end is certain.
    expect(drawn).toContain("/project")
    expect(drawn).toContain("any key wake")
    expect(drawn).toContain("2.2.4")
    // The stub prints once and waits: one shell and its reader, nothing else.
    expect(napped.count).toBe(2)

    await Bun.sleep(1_000)
    const card = (await processTree(tui.pid)).leaderRssKiB
    const plain = await plainStubRss()
    console.log(`napped sh RSS: ${card} KiB with the card, ${plain} KiB for a plain stub (${card - plain} KiB more)`)
    expect(card - plain, await run.context()).toBeLessThan(RSS_BUDGET_KIB)

    const offset = tui.output().length
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    // The card's colours and screen are cleared before OpenCode starts.
    expect(tui.output().slice(offset)).toContain("\x1b[0m\x1b[2J\x1b[H")
    expect(stripEscapesSince(tui, offset)).not.toContain("Napping…")
  }, 180_000)
})
