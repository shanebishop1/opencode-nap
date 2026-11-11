import { mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { installedPackage, installObserver, writeCliConfig, type Scratch } from "./harness.js"
import { processTree } from "./processes.js"
import { stripEscapes, type PtyProcess } from "./pty.js"

export const CARD = /Napping… press any key or click to wake/g
export const SPACE = " "
// A left click, press and release, in SGR mouse encoding.
export const CLICK = "\x1b[<0;20;10M\x1b[<0;20;10m"

// Anything but control characters, which could submit or reach a dialog.
const isPrintable = (text: string): boolean =>
  [...text].every(character => {
    const code = character.codePointAt(0) ?? 0
    return code >= 0x20 && (code < 0x7f || code > 0x9f)
  })

export const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))

export type Entry = Record<string, any>

// A napping window's process is the stub, `sh -c <script> ...`.
const isStub = (commandLine: string): boolean => /^sh -c /.test(commandLine)

/** What the TUI drew after the given offset in its raw output, as plain text. */
export const stripEscapesSince = (tui: PtyProcess, offset: number): string => stripEscapes(tui.output().slice(offset))

export async function readJsonLines(file: string): Promise<Entry[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** Polls until `read` returns a value, or throws with `context()` after the timeout. */
export async function waitUntil<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs: number, what: string, context: () => string = () => ""): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${context()}`)
    await sleep(50)
  }
}

/** The plugin config of one TUI run: opencode-nap with its own debug log, and the observer plugin. */
export class Watch {
  readonly napLog: string
  readonly observerLog: string
  readonly controlDir: string

  private constructor(root: string, name: string) {
    this.napLog = join(root, `${name}.nap.jsonl`)
    this.observerLog = join(root, `${name}.observer.jsonl`)
    this.controlDir = join(root, `${name}.control`)
  }

  /** Writes cli.json for the next TUI started in this scratch. */
  static async configure(scratch: Scratch, name: string, napOptions: Record<string, unknown>): Promise<Watch> {
    const watch = new Watch(scratch.root, name)
    await mkdir(watch.controlDir, { recursive: true })
    const observer = await installObserver(scratch)
    await writeCliConfig(scratch, [
      { package: installedPackage(scratch), options: { ...napOptions, debugLogFile: watch.napLog } },
      { package: observer, options: { logFile: watch.observerLog, controlDir: watch.controlDir } },
    ])
    return watch
  }

  napEntries = () => readJsonLines(this.napLog)
  observerEntries = () => readJsonLines(this.observerLog)

  /** Asks the observer plugin to do something and returns its report. */
  async ask(name: string, input = "", timeoutMs = 10_000): Promise<Entry> {
    const before = (await this.observerEntries()).length
    await writeFile(join(this.controlDir, name), input)
    return waitUntil(async () => (await this.observerEntries()).slice(before).find(entry => entry.event === name), timeoutMs,
      `the observer to handle "${name}"`)
  }
}

/**
 * Drives one TUI under the PTY. It sends an awake prompt only printable draft
 * text, and wake input only once the window is proved to be napping.
 */
export class NapRun {
  private cardsSeen = 0

  constructor(readonly tui: PtyProcess, readonly watch: Watch, readonly pid: number = tui.pid) {}

  context = async (): Promise<string> =>
    `nap log:\n${JSON.stringify(await this.watch.napEntries()).slice(-2500)}\n` +
    `observer log:\n${JSON.stringify(await this.watch.observerEntries()).slice(-2500)}\n` +
    `screen:\n${this.tui.text().slice(-2500)}`

  private cards = () => [...stripEscapes(this.tui.output()).matchAll(CARD)].length

  watchingCount = async (): Promise<number> => (await this.watch.napEntries()).filter(entry => entry.message === "watching").length

  async assertNapping(): Promise<void> {
    const tree = await processTree(this.pid)
    if (!isStub(tree.leader)) throw new Error(`expected the window to be napping: ${tree.leader}\n${await this.context()}`)
  }

  /** Waits for the plugin's nth "watching" line and returns when it was seen. */
  async waitForWatching(count: number, timeoutMs = 60_000): Promise<number> {
    let detail = ""
    await waitUntil(async () => {
      const messages = (await this.watch.napEntries()).map(entry => entry.message)
      detail = JSON.stringify(messages)
      return messages.filter(message => message === "watching").length >= count ? true : undefined
    }, timeoutMs, `"watching" #${count}`, () => detail)
    return Date.now()
  }

  /** Waits for an interactive prompt in the original TUI process after `since`. */
  async waitForInteractive(since: number, timeoutMs = 60_000): Promise<Entry> {
    return waitUntil(async () => (await this.watch.observerEntries())
      .find(entry => entry.event === "interactive" && entry.pid === this.pid && entry.time >= since), timeoutMs, "an interactive prompt in the original TUI process")
  }

  /** Waits for the next nap card and for the process to have become the stub. */
  async waitForNap(timeoutMs: number): Promise<{ at: number; rssKiB: number; count: number }> {
    const card = await waitUntil(() => (this.cards() > this.cardsSeen ? Date.now() : undefined), timeoutMs, "the nap card")
    const tree = await waitUntil(async () => {
      const found = await processTree(this.pid)
      return isStub(found.leader) && found.count >= 2 ? found : undefined
    }, 5_000, "the stub and its reader")
    this.cardsSeen = this.cards()
    return { at: card, rssKiB: tree.rssKiB, count: tree.count }
  }

  /** Types a draft into the awake prompt, one character at a time. */
  async typeDraft(text: string): Promise<void> {
    if (!isPrintable(text)) throw new Error("only printable characters may be typed into an awake prompt")
    for (const character of text) {
      this.tui.write(character)
      await sleep(20)
    }
  }

  /** Pastes a draft into the awake prompt. Newlines inside a bracketed paste are text, not Enter. */
  pasteDraft(text: string): void {
    if (!isPrintable(text.replace(/\n/g, ""))) throw new Error("only printable characters and newlines may be pasted")
    this.tui.write(`\x1b[200~${text}\x1b[201~`)
  }

  /** Sends a wake key or click to a window proved to be napping; returns when it was sent. */
  async wake(input: string): Promise<number> {
    const tree = await processTree(this.pid)
    if (!isStub(tree.leader) || this.cards() !== this.cardsSeen) {
      throw new Error(`refusing to type into a window that is not napping: ${tree.leader}`)
    }
    if (input !== SPACE && input !== CLICK) throw new Error("only Space or a click may wake a window")
    const at = Date.now()
    this.tui.write(input)
    return at
  }
}
