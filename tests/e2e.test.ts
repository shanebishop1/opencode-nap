import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"
import { $ } from "bun"
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

type LogEntry = { time?: string; message?: string; detail?: Record<string, any> }

const readLog = async (file: string): Promise<LogEntry[]> => {
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
    const options = { idleMinutes: 5, debugLogFile }
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
    await tui.stop()
  }, 120_000)

  it("ac-idle-nap, ac-wake-key: naps in place under 5 MB and a Space wakes it into the same session", async () => {
    if (!scratch || !server) throw new Error("setup failed")
    const debugLogFile = join(scratch.root, "nap-wake.log")
    await writeCliConfig(scratch, [{ package: installedPackage(scratch), options: { idleMinutes: 0.25, debugLogFile } }])

    const sessionID = await createSession(scratch, server.url)
    const tui = await startTui(scratch, server.url, sessionID)
    const context = () => `log:\n${JSON.stringify(entriesSoFar, null, 1).slice(-3000)}\nTUI screen:\n${tui.text().slice(-3000)}`
    let entriesSoFar: LogEntry[] = []
    const waitForLog = async (count: number, message: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        entriesSoFar = await readLog(debugLogFile)
        if (entriesSoFar.filter(entry => entry.message === message).length >= count) return Date.now()
        await sleep(100)
      }
      throw new Error(`timed out waiting for "${message}" #${count}\n${context()}`)
    }

    const watchingAt = await waitForLog(1, "watching", 60_000)
    expect(entriesSoFar.map(entry => entry.message), context()).toEqual(["loaded", "watching"])
    await sleep(3_000)
    const promptBefore = lastCursor(tui.output())
    expect(promptBefore, context()).toBeDefined()
    const awake = await processTree(tui.pid)
    expect(awake.leader, context()).toContain("opencode")

    // 15 s idle, checked at most every 5 s, plus the exec.
    const cardShown = await tui.waitFor(/Napping to save memory\. Press any key or click to wake\./, 40_000)
    const nappedAt = Date.now()
    expect(cardShown, context()).toBeTruthy()
    expect(nappedAt - watchingAt, context()).toBeLessThan(15_000 + 15_000)
    await sleep(500)
    const napped = await processTree(tui.pid)
    expect(napped.leader, context()).toMatch(/^sh -c /)
    expect(napped.rssKiB, context()).toBeLessThan(5 * 1024)

    const spaceAt = Date.now()
    tui.write(" ")
    const wokeAt = await waitForLog(2, "watching", 60_000)
    const woken = await processTree(tui.pid)
    const argv = (await readFile(`/proc/${tui.pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
    expect(argv.slice(1), context()).toEqual(["--server", server.url, scratch.project, "-s", sessionID])
    expect(entriesSoFar.map(entry => entry.message), context()).toEqual(["loaded", "watching", "napping", "loaded", "watching"])
    expect(entriesSoFar[2].detail?.route, context()).toEqual({ type: "session", sessionID })

    // The empty prompt's cursor is where it was before the nap; a Space that
    // reached the prompt would have moved it one column.
    await sleep(3_000)
    const raw = tui.output()
    const promptAfter = lastCursor(raw.slice(raw.lastIndexOf("Napping to save memory")))
    expect(promptAfter, context()).toEqual(promptBefore)
    console.log(`awake ${awake.rssKiB} KiB; napped ${napped.rssKiB} KiB over ${napped.count} processes; ` +
      `idle to card ${nappedAt - watchingAt} ms; Space to plugin running ${wokeAt - spaceAt} ms; woken ${woken.rssKiB} KiB`)
  }, 180_000)
})

/** The last place the TUI showed its cursor, as "row;column". */
function lastCursor(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const shown = [...raw.matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)]
  const last = shown[shown.length - 1]
  return last ? `${last[1]};${last[2]}` : undefined
}

/** Resident memory of a process and its descendants, and the leader's command line. */
async function processTree(pid: number): Promise<{ leader: string; rssKiB: number; count: number }> {
  const rows = (await $`ps -A -o pid=,ppid=,rss=,args=`.quiet().text())
    .split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), args: match[4] }))
  const family = new Set([pid])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid)
        grew = true
      }
    }
  }
  const members = rows.filter(row => family.has(row.pid))
  return {
    leader: rows.find(row => row.pid === pid)?.args ?? "",
    rssKiB: members.reduce((total, row) => total + row.rss, 0),
    count: members.length,
  }
}
