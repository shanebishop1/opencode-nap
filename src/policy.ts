import type { NapOptions } from "./config.js"

export type Focus = "focused" | "unfocused" | "unknown"

export interface PolicyInput {
  now: number
  lastInputAt: number
  focus: Focus
  unfocusedSince: number | undefined
  deferReasons: string[]
}

export type Decision =
  | { action: "nap"; rule: "idle" }
  | { action: "wait"; checkAfterMs: number; deferred: string[] }

type RuleOptions = Pick<NapOptions, "idleMinutes" | "napOnBlur" | "blurIdleMinutes">

interface RuleCheck {
  rule: "idle"
  due: boolean
  dueInMs: number
}

type Rule = (input: PolicyInput, options: RuleOptions) => RuleCheck

const MINUTE_MS = 60_000
const MIN_CHECK_MS = 1_000
const MAX_CHECK_MS = 5_000
const DEFERRED_CHECK_MS = 5_000

const idleRule: Rule = (input, options) => {
  const idleMs = Math.max(0, input.now - input.lastInputAt)
  const thresholdMs = options.idleMinutes * MINUTE_MS
  return { rule: "idle", due: idleMs >= thresholdMs, dueInMs: Math.max(0, thresholdMs - idleMs) }
}

const rules: Rule[] = [idleRule]

export function decide(input: PolicyInput, options: RuleOptions): Decision {
  const checks = rules.map(rule => rule(input, options))
  const due = checks.find(check => check.due)

  if (due) {
    if (input.deferReasons.length > 0) {
      return { action: "wait", checkAfterMs: DEFERRED_CHECK_MS, deferred: [...input.deferReasons] }
    }
    return { action: "nap", rule: due.rule }
  }

  const nextDueMs = Math.min(...checks.map(check => check.dueInMs))
  return {
    action: "wait",
    checkAfterMs: Math.min(MAX_CHECK_MS, Math.max(MIN_CHECK_MS, nextDueMs)),
    deferred: [],
  }
}
