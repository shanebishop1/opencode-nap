import { rmSync } from "fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { randomBytes } from "crypto"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { $ } from "bun"
import { killGroup, startPty, type PtyProcess } from "./pty.js"

export const cliVersion = process.env.NAP_E2E_CLI_VERSION ?? "2.2.4"
const repositoryRoot = resolve(import.meta.dir, "..", "..")

/**
 * An isolated OpenCode setup: HOME, every XDG directory and TMPDIR live in
 * one scratch directory, the server is private to the test, and no model
 * provider is enabled.
 */
export type Scratch = {
  root: string
  project: string
  home: string
  configHome: string
  env: Record<string, string>
  password: string
  binary: string
}

const tracked = new Set<PtyProcess>()
const scratchRoots = new Set<string>()

const forceCleanup = () => {
  for (const pty of tracked) {
    killGroup(pty.pid)
    try {
      process.kill(pty.driverPid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
}

let signalsInstalled = false
const installSignalCleanup = () => {
  if (signalsInstalled) return
  signalsInstalled = true
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      forceCleanup()
      process.exit(130)
    })
  }
  process.once("exit", forceCleanup)
}

const isolatedEnvironment = (root: string, home: string, password: string): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && (["PATH", "LANG", "TERM", "COLORTERM", "TZ"].includes(key) || key.startsWith("LC_")))
  const temporary = join(root, "tmp")
  const runtime = join(root, "run")
  return {
    ...Object.fromEntries(inherited) as Record<string, string>,
    TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: runtime,
    OPENCODE_CONFIG: join(root, "project", "opencode.json"),
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_LOG_LEVEL: "info",
    CI: "1",
  }
}

/** Packs this repository and installs the tarball and the OpenCode CLI into a fresh scratch project. */
export async function createScratch(): Promise<Scratch> {
  installSignalCleanup()
  const root = await mkdtemp(join(tmpdir(), "opencode-nap-e2e-"))
  scratchRoots.add(root)
  const project = join(root, "project")
  const home = join(root, "home")
  const password = randomBytes(24).toString("hex")
  const env = isolatedEnvironment(root, home, password)
  await Promise.all([project, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]
    .map(path => mkdir(path, { recursive: true })))
  await mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })

  const archive = (await $`npm run build && npm pack --ignore-scripts --pack-destination ${root}`
    .cwd(repositoryRoot)
    .quiet()
    .text())
    .trim()
    .split("\n")
    .pop()
  if (!archive) throw new Error("npm pack did not return an archive name")

  // npm runs with the caller's environment so it can use its own cache and
  // registry settings; only OpenCode itself runs isolated.
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await $`npm install --no-audit --no-fund ${join(root, archive)} ${`@opencode/cli@${cliVersion}`}`
    .cwd(project)
    .quiet()
  // Providers are denied outright, so nothing can reach a hosted model.
  await writeFile(env.OPENCODE_CONFIG, JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: [] }, null, 2))

  return {
    root,
    project,
    home,
    configHome: env.XDG_CONFIG_HOME,
    env,
    password,
    binary: join(project, "node_modules", ".bin", "opencode"),
  }
}

/** Writes the TUI plugin config, `$XDG_CONFIG_HOME/opencode/cli.json`. */
export async function writeCliConfig(scratch: Scratch, plugins: unknown[]): Promise<void> {
  const directory = join(scratch.configHome, "opencode")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "cli.json"), JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", plugins }, null, 2))
}

export const installedPackage = (scratch: Scratch): string => join(scratch.project, "node_modules", "opencode-nap")

export type RunOptions = { cwd?: string; env?: Record<string, string> }

const run = async (scratch: Scratch, name: string, command: string[], options: RunOptions = {}): Promise<PtyProcess> => {
  const pty = await startPty({
    command,
    env: options.env ?? scratch.env,
    cwd: options.cwd ?? scratch.project,
    outputFile: join(scratch.root, `${name}.out`),
  })
  tracked.add(pty)
  return pty
}

/** Starts a private `opencode serve` on loopback and returns its URL. */
export async function startServer(scratch: Scratch): Promise<{ process: PtyProcess; url: string }> {
  const server = await run(scratch, "server", [scratch.binary, "serve", "--hostname", "127.0.0.1", "--port", "0"])
  const [, url] = await server.waitFor(/server listening on (http:\/\/127\.0\.0\.1:\d+)/, 30_000)
  return { process: server, url }
}

export const apiHeaders = (scratch: Scratch): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`opencode:${scratch.password}`).toString("base64")}`,
  "content-type": "application/json",
  "x-opencode-directory": scratch.project,
})

export async function createSession(scratch: Scratch, url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: apiHeaders(scratch),
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`creating a session failed: HTTP ${response.status}: ${body}`)
  const id = (JSON.parse(body) as { data?: { id?: unknown } }).data?.id
  if (typeof id !== "string") throw new Error(`unexpected session response: ${body}`)
  return id
}

/** Runs the TUI against the private server. It never receives input. */
export const startTui = (scratch: Scratch, url: string, sessionID: string): Promise<PtyProcess> =>
  run(scratch, "tui", [scratch.binary, "--server", url, "-s", sessionID, scratch.project])

/**
 * Runs the TUI with the given arguments under its own output file. The
 * arguments must name the private server with --server: only a test that has
 * proved it runs in a private network namespace may leave it out.
 */
export const startTuiWith = (scratch: Scratch, name: string, args: string[], options: RunOptions = {}): Promise<PtyProcess> =>
  run(scratch, name, [scratch.binary, ...args], options)

/** Runs any command under the harness, so cleanup stops it with the rest. */
export const startCommand = (scratch: Scratch, name: string, command: string[], options: RunOptions = {}): Promise<PtyProcess> =>
  run(scratch, name, command, options)

/** Replaces the server config. The server reads it when it starts. */
export async function writeServerConfig(scratch: Scratch, config: Record<string, unknown>): Promise<void> {
  await writeFile(scratch.env.OPENCODE_CONFIG, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }, null, 2))
}

/** Calls the private server's API and returns the parsed JSON body. Throws on an HTTP error. */
export async function callApi(scratch: Scratch, url: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: apiHeaders(scratch),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}: ${text.slice(0, 2000)}`)
  return text ? JSON.parse(text) : undefined
}

const fixtures = resolve(import.meta.dir, "..", "fixtures")

/** Copies the observer plugin into the scratch directory and returns its path for cli.json. */
export async function installObserver(scratch: Scratch): Promise<string> {
  const directory = join(scratch.root, "observer-plugin")
  await cp(join(fixtures, "observer-plugin"), directory, { recursive: true })
  return directory
}

/** Starts the fake OpenAI-compatible provider on a free loopback port and returns its URL. */
export async function startProvider(scratch: Scratch, logFile: string, slow: { chunks: number; delayMs: number }): Promise<{ process: PtyProcess; url: string }> {
  const provider = await run(scratch, "provider", [
    process.execPath, join(fixtures, "local-openai-server.ts"), "0", logFile, String(slow.chunks), String(slow.delayMs),
  ])
  const [, url] = await provider.waitFor(/READY (http:\/\/127\.0\.0\.1:\d+)/, 30_000)
  return { process: provider, url }
}

type ProcessInfo = { pid: number; ppid: number; args: string }

const listProcesses = async (): Promise<ProcessInfo[]> =>
  (await $`ps -A -o pid=,ppid=,args=`.quiet().text())
    .split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }))

const descendants = (processes: ProcessInfo[], roots: number[]): Set<number> => {
  const found = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const info of processes) {
      if (found.has(info.ppid) && !found.has(info.pid)) {
        found.add(info.pid)
        grew = true
      }
    }
  }
  return found
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Stops every process this harness started, with their descendants, removes
 * the scratch directories, and returns any process that survived (after
 * killing it), so the caller can fail loudly.
 */
export async function cleanup(): Promise<string[]> {
  const before = await listProcesses()
  const started = [...tracked].flatMap(pty => [pty.driverPid, pty.pid])
  const family = descendants(before, started)
  await Promise.all([...tracked].map(pty => pty.stop()))
  tracked.clear()

  const roots = [...scratchRoots]
  const after = await listProcesses()
  const survivors = after.filter(info =>
    (family.has(info.pid) && alive(info.pid)) || roots.some(root => info.args.includes(root)))
  for (const info of survivors) {
    try {
      process.kill(info.pid, "SIGKILL")
    } catch {
      // Exited meanwhile.
    }
  }
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  scratchRoots.clear()
  return survivors.map(info => `${info.pid} ${info.args}`)
}
