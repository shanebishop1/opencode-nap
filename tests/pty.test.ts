import { expect, it } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

it.skipIf(process.platform === "win32")("PTY teardown bounds an uncooperative command and leaves no timer keeping Bun alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "nap-pty-stop-"))
  try {
    const child = Bun.spawn([process.execPath, "-e", `
    import { startPty } from ${JSON.stringify(join(import.meta.dir, "e2e", "pty.ts"))}
    const pty = await startPty({
      command: ["/bin/sh", "-c", "trap '' TERM; printf READY; while :; do sleep 1; done"],
      env: process.env, cwd: ${JSON.stringify(root)}, outputFile: ${JSON.stringify(join(root, "output"))},
    })
    try { await pty.waitFor(/READY/, 2_000) } finally { await pty.stop() }
    `], {
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root },
      stdout: "pipe", stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill(9), 3_000)
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
    } finally {
      clearTimeout(timeout)
      child.kill()
      await child.exited
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 5_000)
