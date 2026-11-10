import { readFile } from "fs/promises"
import { resolve } from "path"
import { $ } from "bun"
import { pythonPath } from "./pty.js"

export type ProcessInfo = { pid: number; ppid: number; rss: number; args: string }

export const listProcesses = async (): Promise<ProcessInfo[]> =>
  (await $`ps -A -o pid=,ppid=,rss=,args=`.quiet().text())
    .split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), args: match[4] }))

/** The given pids and every descendant of them. */
export function descendants(processes: ProcessInfo[], roots: number[]): Set<number> {
  const found = new Set(roots)
  for (let grew = true; grew;) {
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

/** A process and its descendants: their resident memory and the leader's command line. */
export async function processTree(pid: number): Promise<{ leader: string; rssKiB: number; count: number; members: ProcessInfo[] }> {
  const processes = await listProcesses()
  const family = descendants(processes, [pid])
  const members = processes.filter(info => family.has(info.pid))
  return {
    leader: processes.find(info => info.pid === pid)?.args ?? "",
    rssKiB: members.reduce((total, info) => total + info.rss, 0),
    count: members.length,
    members,
  }
}

const procargs = resolve(import.meta.dir, "procargs.py")

// macOS has no /proc, so there a process's argv and environment come from sysctl.
const readProc = async (pid: number, file: "cmdline" | "environ"): Promise<string[]> => {
  const fields = process.platform === "darwin"
    ? (JSON.parse(await $`${pythonPath()} -I ${procargs} ${pid}`.quiet().text()) as Record<typeof file, string[]>)[file]
    : (await readFile(`/proc/${pid}/${file}`, "utf8")).split("\0")
  return fields.filter(Boolean)
}

export const readArgv = (pid: number): Promise<string[]> => readProc(pid, "cmdline")

/** The environment a process was started with. Never print the values: they include the server password. */
export async function readEnviron(pid: number): Promise<Map<string, string>> {
  const entries = await readProc(pid, "environ")
  return new Map(entries.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]))
}
