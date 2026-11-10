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
import { stripEscapes, type PtyProcess } from "./e2e/pty.js"

const enabled = process.env.NAP_E2E === "1"

let scratch: Scratch | undefined
let server: { process: PtyProcess; url: string } | undefined

const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))

const CARD = /Napping to save memory\. Press any key or click to wake\./
const FOCUS_IN = "\x1b[I"
const FOCUS_OUT = "\x1b[O"
const FOCUS_MODE_QUERY = "\x1b[?1004$p"
const FOCUS_MODE_REPLY = "\x1b[?1004;2$y"

type LogEntry = { time?: string; message?: string; detail?: Record<string, any> }

const readLog = async (file: string): Promise<LogEntry[]> => {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

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

const leader = async (pid: number): Promise<string> =>
  (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ")

/** A TUI with the plugin and the given options, on a terminal that reports focus like a real one. */
async function open(name: string, options: Record<string, unknown>) {
  if (!scratch || !server) throw new Error("setup failed")
  const debugLogFile = join(scratch.root, `${name}.log`)
  await writeCliConfig(scratch, [{ package: installedPackage(scratch), options: { ...options, debugLogFile } }])
  const sessionID = await createSession(scratch, server.url)
  // Every TUI in the scratch appends to the same output file; keep to this one's part.
  const offset = (await readFile(join(scratch.root, "tui.out"), "utf8").catch(() => "")).length
  const tui = await startTui(scratch, server.url, sessionID)
  const output = () => tui.output().slice(offset)
  const screen = () => stripEscapes(output())

  let entries: LogEntry[] = []
  const context = () => `log:\n${JSON.stringify(entries, null, 1).slice(-3000)}\nTUI screen:\n${screen().slice(-3000)}`
  const messages = () => entries.map(entry => entry.message)
  const refresh = async () => {
    entries = await readLog(debugLogFile)
    return entries
  }
  const waitFor = async (what: string, found: () => boolean | Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await found()) return Date.now()
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${what}\n${context()}`)
  }
  const waitForLog = (count: number, message: string, timeoutMs: number) =>
    waitFor(`"${message}" #${count}`, async () => (await refresh()).filter(entry => entry.message === message).length >= count, timeoutMs)
  const waitForCard = (timeoutMs: number) => waitFor("the nap card", () => CARD.test(screen()), timeoutMs)
  /** The rule the nap was logged with, once it is logged. */
  const napRule = async () => {
    await waitForLog(1, "napping", 5_000)
    return entries.find(entry => entry.message === "napping")?.detail?.rule
  }
  /**
   * Sends a focus report as a terminal would: only while focus reporting is
   * on. Returns whether it was sent.
   */
  const focus = (report: typeof FOCUS_IN | typeof FOCUS_OUT): boolean => {
    if (!focusReporting(output())) return false
    tui.write(report)
    return true
  }

  // OpenCode turns focus reporting on only for a terminal that answers its
  // mode query, so answer as a terminal that supports the mode (reset).
  await waitFor("the focus mode query", () => output().includes(FOCUS_MODE_QUERY), 60_000)
  tui.write(FOCUS_MODE_REPLY)
  const watchingAt = await waitForLog(1, "watching", 60_000)
  await waitFor("focus reporting on", () => focusReporting(output()), 30_000)
  // Let the first screen settle so the reports reach a running renderer.
  await sleep(2_000)
  return { tui, watchingAt, context, messages, refresh, waitForLog, waitForCard, napRule, focus, output, screen }
}

describe.skipIf(!enabled)(`OpenCode ${cliVersion} focus rules in a real TUI`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterAll(async () => {
    const survivors = await cleanup()
    if (survivors.length) throw new Error(`processes outlived the test and were killed:\n${survivors.join("\n")}`)
  }, 60_000)

  it("ac-focus-events, ac-nap-on-blur: naps about 2 seconds after the terminal reports focus out", async () => {
    const { tui, context, messages, napRule, waitForCard, focus } = await open("blur", { idleMinutes: 5, napOnBlur: true })
    expect(focus(FOCUS_IN), context()).toBe(true)
    await sleep(500)
    expect(focus(FOCUS_OUT), context()).toBe(true)
    const blurAt = Date.now()
    await waitForCard(15_000)
    const cardAt = Date.now()
    expect(await napRule(), context()).toBe("blur")
    expect(messages(), context()).toEqual(["loaded", "watching", "napping"])
    expect(cardAt - blurAt, context()).toBeGreaterThanOrEqual(1_900)
    expect(cardAt - blurAt, context()).toBeLessThan(6_000)
    console.log(`focus out to card ${cardAt - blurAt} ms`)
    await tui.stop()
  }, 120_000)

  it("ac-blur-debounce: focus out and back in within a second does not nap", async () => {
    const { tui, context, messages, refresh, waitForCard, screen, focus } = await open("debounce", { idleMinutes: 5, napOnBlur: true })
    const pid = tui.pid
    const before = await leader(pid)
    expect(before, context()).toContain("opencode")
    expect(focus(FOCUS_OUT), context()).toBe(true)
    await sleep(1_000)
    expect(focus(FOCUS_IN), context()).toBe(true)
    await sleep(8_000)
    await refresh()
    expect(messages(), context()).toEqual(["loaded", "watching"])
    expect(await leader(pid), context()).toBe(before)
    expect(screen(), context()).not.toMatch(CARD)

    // The same window still naps when focus stays out, so the rule was live.
    expect(focus(FOCUS_OUT), context()).toBe(true)
    await waitForCard(15_000)
    await tui.stop()
  }, 120_000)

  it("ac-blur-idle: naps after blurIdleMinutes while unfocused, long before idleMinutes", async () => {
    const { tui, watchingAt, context, napRule, waitForCard, focus } = await open("blur-idle", { idleMinutes: 5, blurIdleMinutes: 0.25 })
    expect(focus(FOCUS_OUT), context()).toBe(true)
    await waitForCard(40_000)
    const cardAt = Date.now()
    expect(await napRule(), context()).toBe("blurIdle")
    // 15 s idle from the plugin's start, checked at most every 5 s, plus the exec.
    expect(cardAt - watchingAt, context()).toBeGreaterThanOrEqual(14_000)
    expect(cardAt - watchingAt, context()).toBeLessThan(15_000 + 15_000)
    console.log(`blurIdle: plugin start to card ${cardAt - watchingAt} ms`)
    await tui.stop()
  }, 120_000)

  it("ac-focus-no-wake: focus changes leave a napping window napping; Space wakes it", async () => {
    const { tui, context, messages, refresh, waitForLog, waitForCard, output, focus } = await open("no-wake", { idleMinutes: 5, napOnBlur: true })
    const pid = tui.pid
    expect(focus(FOCUS_OUT), context()).toBe(true)
    await waitForCard(15_000)
    await sleep(500)
    const napped = await leader(pid)
    expect(napped, context()).toMatch(/^sh -c /)
    // The stub turned focus reporting off, so a terminal sends nothing on a focus change.
    const sent = [FOCUS_IN, FOCUS_OUT, FOCUS_IN, FOCUS_OUT].map(report => focus(report))
    expect(sent, context()).toEqual([false, false, false, false])
    await sleep(3_000)
    await refresh()
    expect(messages(), context()).toEqual(["loaded", "watching", "napping"])
    expect(await leader(pid), context()).toBe(napped)
    // Nothing was drawn after the card.
    const raw = output()
    expect(stripEscapes(raw.slice(raw.lastIndexOf("Press any key or click to wake."))).trim(), context())
      .toBe("Press any key or click to wake.")

    const spaceAt = Date.now()
    tui.write(" ")
    const wokeAt = await waitForLog(2, "watching", 60_000)
    expect(await leader(pid), context()).toContain("opencode")
    expect(messages(), context()).toEqual(["loaded", "watching", "napping", "loaded", "watching"])
    console.log(`no-wake: Space to plugin running ${wokeAt - spaceAt} ms`)
    await tui.stop()
  }, 120_000)

  it("ac-focus-defaults, ac-focus-not-input: with no focus option, focus reports every few seconds neither nap nor delay the idle nap", async () => {
    const { tui, watchingAt, context, refresh, napRule, waitForCard, focus } = await open("defaults", { idleMinutes: 0.25 })
    let reports = 0
    let lastReportAt = 0
    let next = FOCUS_OUT
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      const entries = await refresh()
      if (entries.some(entry => entry.message === "napping")) break
      if (focus(next)) {
        reports++
        lastReportAt = Date.now()
      }
      next = next === FOCUS_OUT ? FOCUS_IN : FOCUS_OUT
      await sleep(3_000)
    }
    await waitForCard(10_000)
    const cardAt = Date.now()
    expect(await napRule(), context()).toBe("idle")
    expect(reports, context()).toBeGreaterThanOrEqual(4)
    expect(cardAt - watchingAt, context()).toBeGreaterThanOrEqual(14_000)
    expect(cardAt - watchingAt, context()).toBeLessThan(15_000 + 15_000)
    // A report that restarted the idle time would put the nap 15 s after it.
    expect(cardAt - lastReportAt, context()).toBeLessThan(15_000)
    console.log(`defaults: ${reports} focus reports, the last ${cardAt - lastReportAt} ms before the card; ` +
      `plugin start to card ${cardAt - watchingAt} ms`)
    await tui.stop()
  }, 120_000)
})
