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

async function run(file: string): Promise<number> {
  const child = Bun.spawn([process.execPath, "test", join(repository, "tests", file)], {
    cwd: repository,
    env: { ...process.env, NAP_E2E: "1", NAP_E2E_INSTALL: root },
    stdout: "pipe", stderr: "pipe",
  })
  children.add(child)
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  children.delete(child)
  console.log(`\n=== ${file} ===\n${stdout}${stderr}`)
  return code
}

try {
  await install(root)
  const files = (await readdir(join(repository, "tests"))).filter(file => /^e2e(?:\..+)?\.test\.ts$/.test(file)).sort()
  const results: number[] = []
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (files.length && !interrupted) results.push(await run(files.shift()!))
  }))
  process.exitCode = interrupted ? 130 : results.some(code => code !== 0) ? 1 : 0
} finally {
  stop()
  await Promise.all([...children].map(child => child.exited))
  await rm(root, { recursive: true, force: true })
}
