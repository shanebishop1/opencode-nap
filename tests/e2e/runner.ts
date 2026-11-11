import { mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { install } from "./install.js"

const root = await mkdtemp(join(tmpdir(), "opencode-nap-suite-"))
const repository = resolve(import.meta.dir, "..", "..")
const children = new Set<ReturnType<typeof Bun.spawn>>()
let interrupted = false
const stop = () => { for (const child of children) child.kill("SIGTERM") }
const interrupt = () => { interrupted = true; stop() }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, interrupt)

type Job = { file: string; pattern?: string; priority: number }

// Split long files without a manifest that could omit new cases:
// each selected group has an exhaustive complement in its own isolated process.
const groups: Record<string, string[]> = {
  "e2e.core.test.ts": ["ac-idle-nap|ac-wake-click", "ac-home-route|ac-no-resubmit"],
  "e2e.draft.test.ts": ["ac-draft-restored|ac-draft-empty", "ac-draft-off|ac-draft-large"],
  "e2e.focus.test.ts": ["ac-focus-events|ac-blur-debounce"],
}

async function run({ file, pattern }: Job): Promise<number> {
  const command = [process.execPath, "test", join(repository, "tests", file)]
  if (pattern) command.push("--test-name-pattern", pattern)
  const child = Bun.spawn(command, {
    cwd: repository,
    env: { ...process.env, NAP_E2E: "1", NAP_E2E_INSTALL: root },
    stdout: "pipe", stderr: "pipe",
  })
  children.add(child)
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  children.delete(child)
  console.log(`\n=== ${file}${pattern ? ` (${pattern})` : ""} ===\n${stdout}${stderr}`)
  return code
}

try {
  await install(root)
  const files = (await readdir(join(repository, "tests"))).filter(file => /^e2e(?:\..+)?\.test\.ts$/.test(file)).sort()
  // The streaming file is the longest unsplit job; do not leave it in the tail.
  files.sort((a, b) => Number(b === "e2e.run.test.ts") - Number(a === "e2e.run.test.ts"))
  const jobs: Job[] = files.flatMap(file => {
    const patterns = groups[file]
    if (!patterns) return [{ file, priority: /e2e\.(run|config)\.test\.ts/.test(file) ? 0 : 2 }]
    return [
      ...patterns.map(pattern => ({ file, pattern, priority: 0 })),
      { file, pattern: `^(?!.*(?:${patterns.join("|")})).*$`, priority: patterns.length > 1 ? 1 : 0 },
    ]
  })
  // Start long groups first, then the single-case complements, then short files.
  jobs.sort((a, b) => a.priority - b.priority)
  const results: number[] = []
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
    while (jobs.length && !interrupted) results.push(await run(jobs.shift()!))
  }))
  process.exitCode = interrupted ? 130 : results.some(code => code !== 0) ? 1 : 0
} finally {
  interrupted = true
  stop()
  await Promise.all([...children].map(child => child.exited))
  await rm(root, { recursive: true, force: true })
}
