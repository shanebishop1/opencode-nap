import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync } from "fs"
import { join } from "path"
import {
  callApi,
  cleanup,
  cliVersion,
  createScratch,
  createSession,
  e2eEnabled,
  startProvider,
  startServer,
  startTuiWith,
  stopTuis,
  writeServerConfig,
  type Scratch,
} from "./e2e/harness.js"
import { fakeProviderConfig, PERMISSION_DIALOG } from "./e2e/fake-provider.js"
import { NapRun, readJsonLines, SPACE, stripEscapesSince, waitUntil, Watch } from "./e2e/nap-run.js"
import type { PtyProcess } from "./e2e/pty.js"

import { IDLE_MS, napOptions, NAP_TIMEOUT_MS } from "./e2e/timing.js"
// Longer than the idle time plus the check interval, so the nap lands mid-stream.
const SLOW = { chunks: 10, delayMs: 500 }
// Text only the question dialog shows.
const QUESTION_DIALOG = /NAP_E2E question: pick one .*Alpha.*Beta.* Type your own answer/

let scratch: Scratch
let server: { process: PtyProcess; url: string }
let providerLog = ""

const api = (method: string, path: string, body?: unknown) => callApi(scratch, server.url, method, path, body)
const prompt = (sessionID: string, text: string) => api("POST", `/api/session/${sessionID}/prompt`, { text })
const isRunning = async (sessionID: string) => sessionID in (await api("GET", "/api/session/active")).data
const transcript = async (sessionID: string) => JSON.stringify((await api("GET", `/api/session/${sessionID}/message`)).data)
const pendingPermissions = async (sessionID: string): Promise<any[]> => (await api("GET", `/api/session/${sessionID}/permission`)).data
const pendingQuestions = async (sessionID: string): Promise<any[]> =>
  (await api("GET", `/api/session/${sessionID}/form`)).data.filter((form: any) => form.metadata?.kind === "question")

/** Starts a TUI on a new session and waits for the plugin to watch it. */
async function openSession(name: string) {
  const watch = await Watch.configure(scratch, name, napOptions)
  const sessionID = await createSession(scratch, server.url)
  const tui = await startTuiWith(scratch, name, ["--server", server.url, "-s", sessionID, scratch.project])
  const run = new NapRun(tui, watch)
  const watchingAt = await run.waitForWatching(1)
  return { sessionID, tui, run, watchingAt }
}

describe.skipIf(!e2eEnabled)(`OpenCode ${cliVersion}: runs and prompts survive a nap`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
    providerLog = join(scratch.root, "provider.jsonl")
    const provider = await startProvider(scratch, providerLog, SLOW)
    await writeServerConfig(scratch, fakeProviderConfig(provider.url))
    server = await startServer(scratch)
  }, 300_000)

  afterEach(stopTuis, 60_000)

  afterAll(cleanup, 60_000)

  it("ac-run-continues: a run streaming when its only TUI naps finishes in the server, and all of it shows after wake", async () => {
    const { sessionID, tui, run } = await openSession("stream")
    await prompt(sessionID, "NAP_SLOW stream past the nap")
    const call = await waitUntil(async () => (await readJsonLines(providerLog)).find(entry => entry.mode === "slow")?.call, 30_000, "the stream to start")

    await run.waitForNap(NAP_TIMEOUT_MS)
    const providerEvents = async () => (await readJsonLines(providerLog)).filter(entry => entry.call === call)
    expect((await providerEvents()).some(entry => entry.finished), "the stream ended before the nap").toBe(false)
    expect(await isRunning(sessionID)).toBe(true)

    // The run finishes while the window naps.
    await waitUntil(async () => ((await providerEvents()).some(entry => entry.finished || entry.clientGone) ? true : undefined),
      SLOW.chunks * SLOW.delayMs + 30_000, "the stream to end")
    await waitUntil(async () => (!(await isRunning(sessionID)) ? true : undefined), 30_000, "the run to finish")
    expect((await providerEvents()).find(entry => entry.clientGone), "the server dropped the stream").toBeUndefined()
    const text = await transcript(sessionID)
    for (const marker of ["slow-chunk-001", `slow-chunk-0${SLOW.chunks}`, "NAP_SLOW_DONE"]) expect(text).toContain(marker)
    await run.assertNapping()

    const offset = tui.output().length
    const spaceAt = await run.wake(SPACE)
    await run.waitForInteractive(spaceAt)
    await waitUntil(() => (/NAP_SLOW_DONE/.test(stripEscapesSince(tui, offset)) ? true : undefined), 20_000,
      "the finished output after wake", () => stripEscapesSince(tui, offset).slice(-2500))
    expect(stripEscapesSince(tui, offset)).toContain(`slow-chunk-0${SLOW.chunks}`)
  }, 240_000)

  it("ac-prompts-reappear: permission and question prompts, pending at the nap or created while napped, show after wake and can be answered", async () => {
    const { sessionID, tui, run, watchingAt } = await openSession("prompts")
    const visibleAfterWake = async (pattern: RegExp, what: string) => {
      const offset = tui.output().length
      const watching = await run.watchingCount()
      const spaceAt = await run.wake(SPACE)
      await run.waitForWatching(watching + 1)
      await waitUntil(() => (pattern.test(stripEscapesSince(tui, offset)) ? true : undefined), 20_000,
        `the ${what} after wake`, () => stripEscapesSince(tui, offset).slice(-2500))
      return spaceAt
    }

    // A permission prompt pending as the window naps does not delay the nap.
    await prompt(sessionID, "NAP_PERM pending at the nap")
    const [first] = await waitUntil(async () => { const found = await pendingPermissions(sessionID); return found.length ? found : undefined }, 30_000, "the permission prompt")
    const firstNap = await run.waitForNap(NAP_TIMEOUT_MS)
    expect(firstNap.at - watchingAt, await run.context()).toBeLessThan(IDLE_MS + 5_000)
    await visibleAfterWake(PERMISSION_DIALOG, "pending permission prompt")
    // The wake key was swallowed, so the prompt is still waiting for an answer.
    expect((await pendingPermissions(sessionID)).map(request => request.id)).toEqual([first.id])
    await api("POST", `/api/session/${sessionID}/permission/${first.id}/reply`, { decision: "once" })
    await waitUntil(async () => ((await transcript(sessionID)).includes("NAP_PERM_DONE") ? true : undefined), 30_000, "the run to finish after the answer")
    expect(existsSync(join(scratch.project, "nap-e2e-permission.txt"))).toBe(true)

    // A permission prompt created while the window naps.
    await run.waitForNap(NAP_TIMEOUT_MS)
    await prompt(sessionID, "NAP_PERM created while napped")
    const [second] = await waitUntil(async () => { const found = await pendingPermissions(sessionID); return found.length ? found : undefined }, 30_000, "the second permission prompt")
    await run.assertNapping()
    await visibleAfterWake(PERMISSION_DIALOG, "permission prompt created while napped")
    expect((await pendingPermissions(sessionID)).map(request => request.id)).toEqual([second.id])
    await api("POST", `/api/session/${sessionID}/permission/${second.id}/reply`, { decision: "reject" })
    await waitUntil(async () => ((await pendingPermissions(sessionID)).length === 0 && !(await isRunning(sessionID)) ? true : undefined), 30_000, "the rejected run to end")

    // A question created while the window naps.
    await run.waitForNap(NAP_TIMEOUT_MS)
    await prompt(sessionID, "NAP_QUESTION created while napped")
    const [question] = await waitUntil(async () => { const found = await pendingQuestions(sessionID); return found.length ? found : undefined }, 30_000, "the question")
    await run.assertNapping()
    await visibleAfterWake(QUESTION_DIALOG, "question created while napped")
    expect((await pendingQuestions(sessionID)).map(form => form.id)).toEqual([question.id])
    await api("POST", `/api/session/${sessionID}/form/${question.id}/reply`, { answer: { [question.fields[0].key]: "Alpha" } })
    await waitUntil(async () => ((await transcript(sessionID)).includes("NAP_QUESTION_DONE") ? true : undefined), 30_000, "the run to finish after the answer")
  }, 300_000)
})
