import type { Emitter } from "./probe.js"

export interface IdleSourceInput {
  now: () => number
  /** The terminal's access time (fd 0) in ms, or undefined when it cannot be read. */
  readAtime: () => number | undefined
  /** The renderer's key input: emits "keypress" and "paste". */
  keyInput: Emitter
  /** The raw terminal input stream the renderer reads. */
  stdin: Emitter
}

export interface IdleSource {
  /** Time of the latest user input, or of setup when there has been none. */
  lastInputAt(): number
  dispose(): void
}

// SGR (1006), urxvt (1015) and X10 mouse reports.
// eslint-disable-next-line no-control-regex
const MOUSE_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3}/
const MOUSE_TAIL_LIMIT = 64

// A read the plugin saw explains an access time within this window of it. The
// kernel stores whole seconds, so the read is up to a second after the stamp.
const SEEN_BEFORE_MS = 250
const SEEN_AFTER_MS = 1_500
const SEEN_KEEP_MS = 30_000

// A Buffer is a Uint8Array.
const toText = (chunk: unknown): string =>
  typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("latin1") : ""

/**
 * Input is a key press or paste from the renderer, or a mouse report on the
 * raw input stream. Focus reports and terminal replies are neither, so they
 * never count.
 *
 * The terminal's access time is a backstop for input the renderer never
 * reads, such as typing into an external editor OpenCode has suspended
 * itself for. A read bumps it, so an advance counts as input only when the
 * plugin saw no chunk on the input stream at that time: any chunk it saw has
 * already been sorted into input or not.
 */
export function createIdleSource(input: IdleSourceInput): IdleSource {
  let lastInputAt = input.now()
  let lastAtime = input.readAtime()
  let seen: number[] = []
  let mouseTail = ""

  const mark = (at: number) => {
    if (at > lastInputAt) lastInputAt = at
  }
  const onInput = () => mark(input.now())
  const onData = (chunk: unknown) => {
    const now = input.now()
    seen.push(now)
    const text = mouseTail + toText(chunk)
    if (MOUSE_REPORT.test(text)) mark(now)
    // Raw reads can split a report. Keep only a short, unfinished escape
    // sequence so a completed report cannot count again on the next read.
    const escape = text.lastIndexOf("\x1b")
    const tail = escape === -1 ? "" : text.slice(escape)
    mouseTail = tail.length <= MOUSE_TAIL_LIMIT && !MOUSE_REPORT.test(tail) ? tail : ""
  }

  const checkAtime = () => {
    const atime = input.readAtime()
    if (atime === undefined || (lastAtime !== undefined && atime <= lastAtime)) return
    lastAtime = atime
    const now = input.now()
    seen = seen.filter(at => now - at <= SEEN_KEEP_MS)
    const explained = seen.some(at => at >= atime - SEEN_BEFORE_MS && at <= atime + SEEN_AFTER_MS)
    if (!explained) mark(Math.min(atime, now))
  }

  input.keyInput.on("keypress", onInput)
  input.keyInput.on("paste", onInput)
  input.stdin.on("data", onData)

  return {
    lastInputAt() {
      checkAtime()
      return lastInputAt
    },
    dispose() {
      input.keyInput.off("keypress", onInput)
      input.keyInput.off("paste", onInput)
      input.stdin.off("data", onData)
    },
  }
}
