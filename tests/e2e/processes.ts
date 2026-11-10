import { readFile } from "fs/promises"
import { $ } from "bun"

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

export async function readArgv(pid: number): Promise<string[]> {
  return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
}

/** The environment a process was started with. Never print the values: they include the server password. */
export async function readEnviron(pid: number): Promise<Map<string, string>> {
  const entries = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").filter(Boolean)
  return new Map(entries.map(entry => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]))
}
