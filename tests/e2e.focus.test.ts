import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import {
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  e2eEnabled,
  startServer,
  startTuiWith,
  stopTuis,
  type Scratch,
} from "./e2e/harness.js"
import { NapRun, sleep, SPACE, stripEscapesSince, waitUntil, Watch } from "./e2e/nap-run.js"
import { processTree } from "./e2e/processes.js"
import type { PtyProcess } from "./e2e/pty.js"

const FOCUS_IN = "\x1b[I"
const FOCUS_OUT = "\x1b[O"
const FOCUS_MODE_QUERY = "\x1b[?1004$p"
const FOCUS_MODE_REPLY = "\x1b[?1004;2$y"
import { IDLE_MS, napOptions, NAP_SLACK_MS, NAP_TIMEOUT_MS } from "./e2e/timing.js"

let scratch: Scratch
let server: { process: PtyProcess; url: string }

/**
 * Whether the program on the terminal has focus reporting (DEC mode 1004)
 * on, from the last time it set or reset the mode.
 */
function focusReporting(raw: string): boolean {
  let on = false
  // eslint-disable-next-line no-control-regex
  for (const match of raw.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    if (match[1].split(";").includes("1004")) on = match[2] === "h"
  }
  return on
}

const leader = async (pid: number): Promise<string> => (await processTree(pid)).leader

/** A TUI with the plugin and the given options, on a terminal that reports focus like a real one. */
async function open(name: string, options: Record<string, unknown>) {
  const watch = await Watch.configure(scratch, name, options)
  const sessionID = await createSession(scratch, server.url)
  const tui = await startTuiWith(scratch, name, ["--server", server.url, "-s", sessionID, scratch.project])
  const run = new NapRun(tui, watch)
  const messages = async () => (await watch.napEntries()).map(entry => entry.message)
  const napRule = async () => (await watch.napEntries()).find(entry => entry.message === "napping")?.detail?.rule
  /** Sends a focus report as a terminal would: only while focus reporting is on. Returns whether it was sent. */
  const focus = (report: string): boolean => {
    if (!focusReporting(tui.output())) return false
    tui.write(report)
    return true
  }

  // OpenCode turns focus reporting on only for a terminal that answers its
  // mode query, so answer as a terminal that supports the mode (reset).
  await waitUntil(() => tui.output().includes(FOCUS_MODE_QUERY) || undefined, 60_000, "the focus mode query")
  tui.write(FOCUS_MODE_REPLY)
  const watchingAt = await run.waitForWatching(1)
  await waitUntil(() => focusReporting(tui.output()) || undefined, 30_000, "focus reporting on")
  await run.waitForInteractive(0)
  return { tui, run, watchingAt, messages, napRule, focus }
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: focus rules in a real TUI`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("ac-focus-events, ac-nap-on-blur: naps about 2 seconds after the terminal reports focus out", async () => {
    const { run, messages, napRule, focus } = await open("blur", { idleMinutes: 5, napOnBlur: true })
    expect(focus(FOCUS_IN), await run.context()).toBe(true)
    await sleep(500)
    expect(focus(FOCUS_OUT), await run.context()).toBe(true)
    const blurAt = Date.now()
    const napped = await run.waitForNap(15_000)
    expect(await napRule(), await run.context()).toBe("blur")
    expect(await messages(), await run.context()).toEqual(["loaded", "watching", "napping"])
    expect(napped.at - blurAt, await run.context()).toBeGreaterThanOrEqual(1_900)
    expect(napped.at - blurAt, await run.context()).toBeLessThan(6_000)
    console.log(`focus out to card ${napped.at - blurAt} ms`)
  }, 120_000)

  it("ac-blur-debounce: focus out and back in within a second does not nap", async () => {
    const { tui, run, messages, focus } = await open("debounce", { idleMinutes: 5, napOnBlur: true })
    const before = await leader(tui.pid)
    expect(before, await run.context()).toContain("opencode")
    expect(focus(FOCUS_OUT), await run.context()).toBe(true)
    await sleep(1_000)
    expect(focus(FOCUS_IN), await run.context()).toBe(true)
    await sleep(2_200)
    expect(await messages(), await run.context()).toEqual(["loaded", "watching"])
    expect(await leader(tui.pid), await run.context()).toBe(before)

    // The same window still naps when focus stays out, so the rule was live.
    expect(focus(FOCUS_OUT), await run.context()).toBe(true)
    await run.waitForNap(15_000)
  }, 120_000)

  it("ac-blur-idle: naps after blurIdleMinutes while unfocused, long before idleMinutes", async () => {
    const { run, watchingAt, napRule, focus } = await open("blur-idle", { idleMinutes: 5, blurIdleMinutes: napOptions.idleMinutes })
    expect(focus(FOCUS_OUT), await run.context()).toBe(true)
    const napped = await run.waitForNap(NAP_TIMEOUT_MS)
    expect(await napRule(), await run.context()).toBe("blurIdle")
    expect(napped.at - watchingAt, await run.context()).toBeGreaterThanOrEqual(IDLE_MS - 100)
    expect(napped.at - watchingAt, await run.context()).toBeLessThan(IDLE_MS + NAP_SLACK_MS)
    console.log(`blurIdle: plugin start to card ${napped.at - watchingAt} ms`)
  }, 120_000)

  it("ac-focus-no-wake: focus changes leave a napping window napping; Space wakes it", async () => {
    const { tui, run, messages, focus } = await open("no-wake", { idleMinutes: 5, napOnBlur: true })
    expect(focus(FOCUS_OUT), await run.context()).toBe(true)
    await run.waitForNap(15_000)
    const napped = await leader(tui.pid)
    const offset = tui.output().length
    // The stub turned focus reporting off, so a terminal sends nothing on a focus change.
    const sent = [FOCUS_IN, FOCUS_OUT, FOCUS_IN, FOCUS_OUT].map(report => focus(report))
    expect(sent, await run.context()).toEqual([false, false, false, false])
    await sleep(3_000)
    expect(await messages(), await run.context()).toEqual(["loaded", "watching", "napping"])
    expect(await leader(tui.pid), await run.context()).toBe(napped)
    expect(stripEscapesSince(tui, offset).trim(), await run.context()).toBe("")

    const spaceAt = await run.wake(SPACE)
    const wokeAt = await run.waitForWatching(2)
    expect(await leader(tui.pid), await run.context()).toContain("opencode")
    expect(await messages(), await run.context()).toEqual(["loaded", "watching", "napping", "loaded", "watching"])
    console.log(`no-wake: Space to plugin running ${wokeAt - spaceAt} ms`)
  }, 120_000)

  it("ac-focus-defaults, ac-focus-not-input: with no focus option, repeated focus reports neither nap nor delay the idle nap", async () => {
    const { run, watchingAt, messages, napRule, focus } = await open("defaults", napOptions)
    let reports = 0
    let lastReportAt = 0
    let next = FOCUS_OUT
    const deadline = Date.now() + NAP_TIMEOUT_MS
    while (Date.now() < deadline && !(await messages()).includes("napping")) {
      if (focus(next)) {
        reports++
        lastReportAt = Date.now()
      }
      next = next === FOCUS_OUT ? FOCUS_IN : FOCUS_OUT
      await sleep(200)
    }
    const napped = await run.waitForNap(10_000)
    expect(await napRule(), await run.context()).toBe("idle")
    expect(reports, await run.context()).toBeGreaterThanOrEqual(4)
    expect(napped.at - watchingAt, await run.context()).toBeGreaterThanOrEqual(IDLE_MS - 100)
    expect(napped.at - watchingAt, await run.context()).toBeLessThan(IDLE_MS + NAP_SLACK_MS)
    // A report that restarted the idle time would put the nap IDLE_MS after it.
    expect(napped.at - lastReportAt, await run.context()).toBeLessThan(IDLE_MS)
    console.log(`defaults: ${reports} focus reports, the last ${napped.at - lastReportAt} ms before the card; ` +
      `plugin start to card ${napped.at - watchingAt} ms`)
  }, 120_000)
})
