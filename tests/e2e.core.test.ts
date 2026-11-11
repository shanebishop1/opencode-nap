import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import {
  callApi,
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  e2eEnabled,
  startServer,
  startTuiWith as open,
  stopTuis,
  type Scratch,
} from "./e2e/harness.js"
import { CLICK, NapRun, sleep, SPACE, stripEscapesSince, waitUntil, Watch } from "./e2e/nap-run.js"
import { processTree } from "./e2e/processes.js"
import type { PtyProcess } from "./e2e/pty.js"

import { IDLE_MS, napOptions, NAP_SLACK_MS, NAP_TIMEOUT_MS } from "./e2e/timing.js"

let scratch: Scratch
let server: { process: PtyProcess; url: string }

const messagesOf = async (sessionID: string): Promise<any[]> =>
  (await callApi(scratch, server.url, "GET", `/api/session/${sessionID}/message`)).data

const sessionIDs = async (): Promise<string[]> =>
  (await callApi(scratch, server.url, "GET", `/api/session?directory=${encodeURIComponent(scratch.project)}&limit=100`)).data
    .map((session: { id: string }) => session.id)

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: core nap and wake in a real TUI`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("ac-idle-nap, ac-wake-key, ac-wake-latency: naps in place under 5 MB; Space wakes it into the same session and never reaches the prompt", async () => {
    const watch = await Watch.configure(scratch, "space", napOptions)
    const sessionID = await createSession(scratch, server.url)
    const tui = await open(scratch, "space", ["--server", server.url, "-s", sessionID, scratch.project])
    const run = new NapRun(tui, watch)

    const watchingAt = await run.waitForWatching(1)
    await run.waitForInteractive(0)
    const awake = await processTree(tui.pid)
    expect(awake.leader, await run.context()).toContain("opencode")

    const napped = await run.waitForNap(NAP_TIMEOUT_MS)
    expect(napped.at - watchingAt, await run.context()).toBeLessThan(IDLE_MS + NAP_SLACK_MS)
    expect(napped.rssKiB, await run.context()).toBeLessThan(5 * 1024)

    const offset = tui.output().length
    const spaceAt = await run.wake(SPACE)
    const interactive = await run.waitForInteractive(spaceAt)
    const drawnAt = await waitUntil(() => (/ctrl\+p commands/.test(stripEscapesSince(tui, offset)) ? Date.now() : undefined), 30_000, "the prompt to be drawn")
    await run.waitForWatching(2)

    expect((await watch.ask("state")).result.argv, await run.context()).toEqual(["--server", server.url, scratch.project, "-s", sessionID])
    const messages = (await watch.napEntries()).map(entry => entry.message)
    expect(messages, await run.context()).toEqual(["loaded", "watching", "napping", "loaded", "watching"])
    expect((await watch.napEntries())[2].detail?.route).toEqual({ type: "session", sessionID })
    // The Space was swallowed by the stub, so the woken prompt is empty.
    expect(interactive.prompt, await run.context()).toBe("")
    const state = (await watch.ask("state")).result
    expect(state.prompt).toBe("")
    expect(state.route).toEqual({ type: "session", sessionID })
    const woken = await processTree(tui.pid)

    console.log(`nap summary: awake ${(awake.rssKiB / 1024).toFixed(1)} MB RSS; napped ${(napped.rssKiB / 1024).toFixed(1)} MB RSS ` +
      `over ${napped.count} processes; idle to card ${napped.at - watchingAt} ms (idle time ${IDLE_MS} ms); ` +
      `Space to prompt focused ${interactive.time - spaceAt} ms, drawn ${drawnAt - spaceAt} ms; woken ${(woken.rssKiB / 1024).toFixed(1)} MB RSS`)
  }, 180_000)

  it("ac-wake-click, ac-args-kept: a click wakes it with the same flags, absolute directory and environment sentinel", async () => {
    const watch = await Watch.configure(scratch, "click", napOptions)
    const sessionID = await createSession(scratch, server.url)
    // Started from the scratch root with a relative directory, as from a shell.
    const env = { ...scratch.env, PWD: scratch.root, NAP_E2E_MARK: "kept" }
    const args = ["--server", server.url, "--auto", "--log-level", "warn", "-s", sessionID, "project"]
    const tui = await open(scratch, "click", args, { cwd: scratch.root, env })
    const run = new NapRun(tui, watch)

    await run.waitForWatching(1)
    expect((await watch.ask("environment")).result.markerKept).toBe(true)
    await run.waitForNap(NAP_TIMEOUT_MS)
    const clickAt = await run.wake(CLICK)
    const interactive = await run.waitForInteractive(clickAt)
    await run.waitForWatching(2)

    expect((await watch.ask("state")).result.argv, await run.context()).toEqual([
      "--server", server.url, "--auto", "--log-level", "warn", scratch.project, "-s", sessionID,
    ])
    // Bounded inheritance checks avoid reading another process's environment.
    // The stub's shell resets PWD to OpenCode's resolved working directory.
    expect((await watch.ask("environment")).result).toEqual({ markerKept: true, directoryKept: true })
    // No part of the mouse sequence reached the prompt.
    expect(interactive.prompt, await run.context()).toBe("")
    expect((await watch.ask("state")).result.prompt).toBe("")
  }, 180_000)

  it("ac-home-route: a TUI on the start screen naps and wakes to the start screen", async () => {
    const watch = await Watch.configure(scratch, "home", napOptions)
    const before = await sessionIDs()
    const tui = await open(scratch, "home", ["--server", server.url, scratch.project])
    const run = new NapRun(tui, watch)

    await run.waitForWatching(1)
    expect((await watch.ask("state")).result.route, await run.context()).toEqual({ type: "home" })
    await run.waitForNap(NAP_TIMEOUT_MS)
    const offset = tui.output().length
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    await run.waitForWatching(2)

    expect((await watch.ask("state")).result.argv, await run.context()).toEqual(["--server", server.url, scratch.project])
    expect((await watch.napEntries()).find(entry => entry.message === "napping")?.detail?.route).toEqual({ type: "other" })
    expect((await watch.ask("state")).result.route).toEqual({ type: "home" })
    await waitUntil(() => (/Ask anything/.test(stripEscapesSince(tui, offset)) ? true : undefined), 10_000, "the start screen", () => stripEscapesSince(tui, offset))
    expect(await sessionIDs()).toEqual(before)
  }, 180_000)

  it("ac-no-resubmit: a TUI started with --prompt and --continue wakes with neither and one -s, and nothing is sent", async () => {
    // No provider is enabled, so OpenCode only fills the prompt; nothing can reach a model.
    const watch = await Watch.configure(scratch, "prompt", { ...napOptions, carryDraft: false })
    const sessionID = await createSession(scratch, server.url)
    const tui = await open(scratch, "prompt", ["--server", server.url, "--prompt", "NAP_E2E_STARTING_PROMPT", "--continue", scratch.project])
    const run = new NapRun(tui, watch)

    await run.waitForWatching(1)
    const startedWith = (await watch.ask("state")).result
    // --continue opened the newest session with the starting prompt filled in.
    expect(startedWith.route, await run.context()).toMatchObject({ type: "session", sessionID })
    expect(startedWith.prompt).toBe("NAP_E2E_STARTING_PROMPT")
    await run.waitForNap(NAP_TIMEOUT_MS)
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    await run.waitForWatching(2)

    const argv = (await watch.ask("state")).result.argv
    expect(argv, await run.context()).toEqual(["--server", server.url, scratch.project, "-s", sessionID])
    expect((await watch.ask("state")).result.prompt).toBe("")
    expect(await messagesOf(sessionID)).toEqual([])
  }, 180_000)

  it("ac-state-kept: prompt history, tabs and plugin storage after a nap match a quit and restart", async () => {
    // A TUI submit records history, but with no provider OpenCode refuses to
    // submit, so the history file is written the way OpenCode writes it.
    const history = join(scratch.env.XDG_STATE_HOME, "opencode", "prompt-history.jsonl")
    await mkdir(join(scratch.env.XDG_STATE_HOME, "opencode"), { recursive: true })
    await writeFile(history, `${JSON.stringify({ text: "NAP_E2E_HISTORY", files: [], agents: [], skills: [], pasted: [] })}\n`)
    const main = await createSession(scratch, server.url)
    const other = await createSession(scratch, server.url)

    // Opening a tab reaches the tab list a moment later, so read the state once both are listed.
    const observe = async (run: NapRun) => {
      const state = await waitUntil(async () => {
        const result = (await run.watch.ask("state")).result
        return [main, other].every(id => result.tabs.includes(id)) ? result : undefined
      }, 5_000, "both sessions in the tab list")
      await run.watch.ask("history-back")
      const recalled = await waitUntil(async () => {
        const prompt = (await run.watch.ask("state")).result.prompt
        return prompt === "NAP_E2E_HISTORY" ? prompt : undefined
      }, 5_000, "recalled prompt history")
      await run.watch.ask("clear")
      return { route: state.route, tabs: [...state.tabs].sort(), stored: state.stored, recalled }
    }

    const watch = await Watch.configure(scratch, "state", napOptions)
    const tui = await open(scratch, "state", ["--server", server.url, "-s", main, scratch.project])
    const run = new NapRun(tui, watch)
    const watchingAt = await run.waitForWatching(1)
    await run.waitForInteractive(0)
    expect((await watch.ask("tab", other)).result.opened, await run.context()).toBe(true)
    const beforeNap = await observe(run)
    // Written as late as possible before the nap.
    await sleep(Math.max(0, watchingAt + IDLE_MS - 400 - Date.now()))
    expect((await watch.ask("store", "written-before-nap")).result.stored).toBe("written-before-nap")
    await run.waitForNap(NAP_TIMEOUT_MS)
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    const afterWake = await observe(run)
    // Quit, then restart on the same session.
    await tui.stop()

    const restartWatch = await Watch.configure(scratch, "restart", napOptions)
    const restarted = await open(scratch, "restart", ["--server", server.url, "-s", main, scratch.project])
    const restartRun = new NapRun(restarted, restartWatch)
    await restartRun.waitForInteractive(0)
    const afterRestart = await observe(restartRun)

    // Tabs are kept across TUIs, so earlier tests' sessions are open too.
    expect(beforeNap).toMatchObject({ route: { type: "session", sessionID: main }, stored: null, recalled: "NAP_E2E_HISTORY" })
    expect(beforeNap.tabs).toEqual(expect.arrayContaining([main, other]))
    expect(afterWake).toEqual({ ...beforeNap, stored: "written-before-nap" })
    expect(afterRestart).toEqual(afterWake)
  }, 240_000)
})
