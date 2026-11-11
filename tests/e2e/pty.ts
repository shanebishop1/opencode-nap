import { readFileSync } from "fs"
import { resolve } from "path"

const driver = resolve(import.meta.dir, "pty_driver.py")

// Resolved with the caller's environment: a version-manager shim on PATH may
// not work under the isolated HOME the command runs with.
let python = ""
export const pythonPath = (): string => {
  if (!python) {
    const result = Bun.spawnSync(["python3", "-c", "import sys; print(sys.executable)"])
    python = result.stdout.toString().trim()
    if (result.exitCode !== 0 || !python) throw new Error("python3 is required for the PTY driver")
  }
  return python
}

export type PtyOptions = {
  command: string[]
  env: Record<string, string>
  cwd: string
  /** Raw terminal output is appended here. */
  outputFile: string
}

export type PtyProcess = {
  /** The command's pid, which is also its process group id. */
  readonly pid: number
  /** The driver's pid. */
  readonly driverPid: number
  /** Resolves with the command's exit code (negative for a signal). */
  readonly exited: Promise<number | null>
  /** Raw output so far. */
  output(): string
  /** Output so far with terminal escape sequences removed and whitespace collapsed. */
  text(): string
  write(data: string | Uint8Array): void
  waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray>
  /** Stops the command's whole process group and waits for the driver. */
  stop(): Promise<void>
}

const escapes = new RegExp([
  "\\x1b\\[[0-9;?<>=]*[ -/]*[@-~]",
  "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
  "\\x1b[P^_][^\\x1b]*\\x1b\\\\",
  "\\x1b.",
].join("|"), "g")

export const stripEscapes = (raw: string): string => raw.replace(escapes, "").split(/\s+/).join(" ")

const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))

export const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The process group is already gone.
  }
}

/** Runs a command under a pseudo-terminal through pty_driver.py. */
export async function startPty(options: PtyOptions): Promise<PtyProcess> {
  const child = Bun.spawn([
    pythonPath(), "-I", driver,
    "--output", options.outputFile,
    "--cwd", options.cwd,
    "--", ...options.command,
  ], { env: options.env, cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })

  let resolvePid: (pid: number) => void = () => {}
  let resolveExit: (code: number | null) => void = () => {}
  const pid = new Promise<number>(done => { resolvePid = done })
  const exited = new Promise<number | null>(done => { resolveExit = done })
  let driverError = ""
  void new Response(child.stderr).text().then(text => { driverError = text })
  void (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as { pid?: number; exit?: number | null }
        if (message.pid !== undefined) resolvePid(message.pid)
        if ("exit" in message) resolveExit(message.exit ?? null)
      }
    }
    resolvePid(-1)
    resolveExit(null)
  })()

  const commandPid = await pid
  if (commandPid < 0) {
    await child.exited
    throw new Error(`pty driver did not start ${options.command[0]}: ${driverError}`)
  }

  const output = () => {
    try {
      return readFileSync(options.outputFile, "utf8")
    } catch {
      return ""
    }
  }

  return {
    pid: commandPid,
    driverPid: child.pid,
    exited,
    output,
    text: () => stripEscapes(output()),
    write(data) {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
      child.stdin.write(`${JSON.stringify({ write: bytes.toString("base64") })}\n`)
      child.stdin.flush()
    },
    async waitFor(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const match = stripEscapes(output()).match(pattern)
        if (match) return match
        if (child.exitCode !== null) break
        await sleep(100)
      }
      throw new Error(`timed out waiting for ${pattern} in output of ${options.command[0]}:\n${stripEscapes(output()).slice(-2000)}`)
    },
    async stop() {
      if (child.exitCode === null) {
        try {
          child.stdin.end()
        } catch {
          // The driver has already closed its input.
        }
        const timeout = setTimeout(() => {
          // The driver is stuck, so do its job: stop the group, then the driver.
          killGroup(commandPid)
          child.kill(9)
        }, 10_000)
        try {
          await child.exited
        } finally {
          // A losing Promise.race timer would keep the test process alive.
          clearTimeout(timeout)
        }
      }
      await child.exited
    },
  }
}
