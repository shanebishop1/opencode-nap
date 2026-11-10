import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readlinkSync } from "fs"
import { cleanup, cliVersion, createScratch, startCommand, type Scratch } from "./e2e/harness.js"
import { NapRun, processTree, readArgv, SPACE, waitUntil, Watch } from "./e2e/nap-run.js"
import { pythonPath } from "./e2e/pty.js"

const enabled = process.env.NAP_E2E === "1"

// The default service listens on a fixed port (49374, or 49375 for local
// builds) and can replace a running service, so a TUI without --server only
// ever runs inside a private network namespace. This proof runs inside it
// before OpenCode starts: the only interface is loopback, it is up, and
// nothing answers on either port.
const PROOF = `
import os, socket
interfaces = [line.split(":")[0].strip() for line in open("/proc/net/dev").read().splitlines()[2:]]
if interfaces != ["lo"]:
    raise SystemExit("unexpected interfaces: %r" % interfaces)
for port in (49374, 49375):
    probe = socket.socket()
    probe.settimeout(2)
    try:
        probe.connect(("127.0.0.1", port))
    except ConnectionRefusedError:
        pass
    else:
        raise SystemExit("port %d answered" % port)
    finally:
        probe.close()
print("NAP_E2E_PRIVATE_NETWORK " + os.readlink("/proc/self/ns/net"), flush=True)
`

// $1 is python, the rest is the command to run once the proof passes.
const GATE = `python=$1; shift; "$python" -I -c "$PROOF" || exit 97; exec "$@"`

type Isolation = { name: string; prefix: string[]; script: string } | { skip: string }

const works = (command: string[]): boolean => {
  try {
    return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

function findIsolation(): Isolation {
  if (process.platform !== "linux") return { skip: "network namespaces need Linux" }
  const bwrap = ["bwrap", "--dev-bind", "/", "/", "--unshare-net", "--die-with-parent", "--"]
  // bwrap brings loopback up itself.
  if (works([...bwrap, "/bin/true"])) return { name: "bwrap --unshare-net", prefix: bwrap, script: GATE }
  const unshare = ["unshare", "-rn", "--"]
  if (works([...unshare, "/bin/true"])) {
    return { name: "unshare -rn", prefix: unshare, script: `ip link set lo up || exit 96; ${GATE}` }
  }
  return { skip: "neither bwrap --unshare-net nor unshare -rn can create a private network namespace here (unprivileged user namespaces are restricted)" }
}

const isolation: Isolation = enabled ? findIsolation() : { skip: "NAP_E2E is not set" }
const runnable = "prefix" in isolation
if (enabled && !runnable) console.log(`skipping the default-service test: ${"skip" in isolation ? isolation.skip : ""}`)

const netns = (pid: number | "self"): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`)
  } catch {
    return undefined
  }
}

/** Kills every process in the given network namespace: the service the TUI started lives there. */
function killNamespace(namespace: string): void {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || netns(Number(name)) !== namespace) continue
    try {
      process.kill(Number(name), "SIGKILL")
    } catch {
      // Gone already.
    }
  }
}

let scratch: Scratch

describe.skipIf(!runnable)(`OpenCode ${cliVersion}: the default service, in a private network namespace`, () => {
  beforeAll(async () => {
    scratch = await createScratch()
  }, 300_000)

  afterAll(async () => {
    const survivors = await cleanup()
    if (survivors.length) throw new Error(`processes outlived the test and were killed:\n${survivors.join("\n")}`)
  }, 60_000)

  it("ac-both-servers: a TUI on the default service (no --server) naps and wakes", async () => {
    if (!("prefix" in isolation)) throw new Error("unreachable")
    const watch = await Watch.configure(scratch, "service", { idleMinutes: 0.25 })
    // The TUI finds the service through its scratch registration, not a password.
    const env: Record<string, string> = { ...scratch.env, PROOF }
    delete env.OPENCODE_PASSWORD
    delete env.OPENCODE_SERVER_PASSWORD
    const command = [...isolation.prefix, "/bin/sh", "-c", isolation.script, "sh", pythonPath(), scratch.binary, scratch.project]
    const wrapper = await startCommand(scratch, "service-tui", command, { env })
    let namespace: string | undefined
    try {
      const [, proved] = await wrapper.waitFor(/NAP_E2E_PRIVATE_NETWORK (net:\[\d+\])/, 30_000)
      namespace = proved
      expect(namespace).not.toBe(netns("self"))

      // bwrap stays as the parent; unshare execs in place.
      const tuiPid = await waitUntil(async () => (await processTree(wrapper.pid)).members
        .find(member => member.args.startsWith(`${scratch.binary} `) && !member.args.includes(" serve"))?.pid,
      30_000, "the TUI inside the namespace")
      expect(netns(tuiPid)).toBe(namespace)
      const run = new NapRun(wrapper, watch, tuiPid)

      await run.waitForWatching(1, 90_000)
      const before = (await watch.napEntries()).find(entry => entry.message === "watching")?.detail?.serverPid
      expect(typeof before, await run.context()).toBe("number")
      expect(netns(before)).toBe(namespace)

      await run.waitForNap(40_000)
      const spaceAt = await run.wake(SPACE)
      await run.waitForInteractive(spaceAt)
      await run.waitForWatching(2)
      expect((await readArgv(tuiPid)).slice(1), await run.context()).toEqual([scratch.project])
      const after = (await watch.napEntries()).filter(entry => entry.message === "watching")[1]?.detail?.serverPid
      expect(after, "the woken TUI reached the same service").toBe(before)
      console.log(`default service: napped and woke inside ${isolation.name} (${namespace}); service pid ${before}`)
    } finally {
      await wrapper.stop()
      if (namespace) killNamespace(namespace)
    }
  }, 240_000)
})
