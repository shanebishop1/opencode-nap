import type { DraftFiles } from "../src/draft-file.js"
import type { GuardFacts } from "../src/guards.js"
import type { Log } from "../src/log.js"
import type { NapProcess } from "../src/process.js"

type Listener = (...args: unknown[]) => void

export class FakeEmitter {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)?.add(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0)
  }
}

type LogEntry = { message: string; detail?: any }

export function fakeLog(): Log & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const seen = new Set<string>()
  return {
    entries,
    write(message, detail) {
      entries.push({ message, detail })
    },
    once(message, detail) {
      if (seen.has(message)) return
      seen.add(message)
      entries.push({ message, detail })
    },
  }
}

export const SESSION_ID = "ses_abc"
export const SERVER_URL = "http://127.0.0.1:4096"

/** An OpenTUI edit buffer; OpenCode's session prompt unless other traits are given. */
export function fakeEditor(text = "", traits: unknown = { owner: "opencode", role: "prompt" }) {
  const editor = {
    text,
    traits,
    isDestroyed: false,
    cursor: text.length,
    get plainText(): string {
      return editor.text
    },
    setText(value: string) {
      editor.text = value
      editor.cursor = 0
    },
    gotoBufferEnd() {
      editor.cursor = editor.text.length
    },
  }
  return editor
}

const rgba = (r: number, g: number, b: number) => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 })

/** OpenCode's default dark theme, as far as the nap card reads it. */
export const fakeTheme = () => ({
  background: { base: rgba(10, 10, 10) },
  text: { base: rgba(238, 238, 238), muted: rgba(128, 128, 128) },
})

/** A TUI context with every internal the plugin uses; the empty prompt is focused. */
export function fakeContext(stdin: FakeEmitter) {
  const prompt = fakeEditor()
  const renderer = Object.assign(new FakeEmitter(), {
    keyInput: new FakeEmitter(),
    stdin,
    controlState: "auto_started" as unknown,
    currentFocusedEditor: prompt as unknown,
  })
  const context = {
    options: {},
    route: { type: "session", sessionID: SESSION_ID } as unknown,
    title: "Fix the flaky test" as unknown,
    serverPid: 200 as unknown,
    ui: { router: { current: () => context.route } },
    client: { server: { info: async () => ({ pid: context.serverPid, version: "2.2.4" }) } },
    data: {
      session: {
        get: (sessionID: string) => (sessionID === SESSION_ID ? { title: context.title, location: { directory: "/work/project" } } : undefined),
      },
    },
    theme: fakeTheme() as unknown,
    app: { version: "2.2.4" } as unknown,
    renderer,
    prompt,
  }
  return context
}

/** A renderer whose empty prompt is focused. */
export const fakeRenderer = () => {
  const context = fakeContext(new FakeEmitter())
  return Object.assign(context.renderer, { prompt: context.prompt })
}

/** The renderer without the internal the prompt is found through. */
export const withoutCurrentEditor = (r: object) => {
  const copy: Record<string, unknown> = { ...r }
  delete copy.currentFocusedEditor
  return copy
}

export const safeFacts: GuardFacts = {
  platform: "linux",
  hasExecve: true,
  isMainThread: true,
  args: [],
  pid: 100,
  serverPid: 200,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  shExecutable: true,
}

type ExecCall = { file: string; argv: string[]; env: NodeJS.ProcessEnv }

/** A process with a manual clock and timers, and an execve that records its calls. */
export function fakeProcess(overrides: { args?: string[]; facts?: Partial<GuardFacts>; drafts?: DraftFiles } = {}) {
  let now = 1_700_000_000_000
  let atime: number | undefined = now - 60_000
  let nextTimer = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const execs: ExecCall[] = []
  const stdin = new FakeEmitter()
  const state = {
    execveError: undefined as Error | undefined,
    atimeError: undefined as Error | undefined,
    size: { width: 120, height: 36 } as { width: number; height: number } | undefined,
  }

  const proc: NapProcess = {
    now: () => now,
    setTimer(run, ms) {
      const id = nextTimer++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: timer => {
      timers.delete(timer as number)
    },
    args: overrides.args ?? ["--server", SERVER_URL, "-s", SESSION_ID],
    execPath: "/opt/opencode/bin/opencode",
    home: "/home/shane",
    terminalSize: () => state.size,
    env: () => ({ PATH: "/usr/bin", OPENCODE_PASSWORD: "secret" }),
    start: { cwd: "/work/project", pwd: "/work", sameDirectory: () => false },
    stdin,
    readAtime: () => {
      if (state.atimeError) throw state.atimeError
      return atime
    },
    guardFacts: serverPid => ({ ...safeFacts, serverPid, args: proc.args, ...overrides.facts }),
    execve(file, argv, env) {
      execs.push({ file, argv, env })
      if (state.execveError) throw state.execveError
    },
    drafts: overrides.drafts ?? noDrafts,
  }

  return {
    proc,
    stdin,
    execs,
    state,
    timers,
    now: () => now,
    setAtime(value: number | undefined) {
      atime = value
    },
    /** Moves the clock, running due timers in order, and lets pending promises settle. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await settle()
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].run()
      }
      now = end
      await settle()
    },
  }
}

/** No draft handed over, and none stored. */
export const noDrafts: DraftFiles = {
  take: () => undefined,
  save: () => {
    throw new Error("unexpected draft")
  },
  discard: () => {},
  cleanStale: () => {},
}

export const settle = () => new Promise<void>(done => setTimeout(done, 0))
