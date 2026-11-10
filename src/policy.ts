import type { NapOptions } from "./config.js"

export type Focus = "focused" | "unfocused" | "unknown"

export interface PolicyInput {
  now: number
  lastInputAt: number
  focus: Focus
  unfocusedSince: number | undefined
  deferReasons: string[]
}

type RuleName = "idle" | "blurIdle" | "blur"

export type Decision =
  | { action: "nap"; rule: RuleName }
  | { action: "wait"; checkAfterMs: number; deferred: string[] }

type RuleOptions = Pick<NapOptions, "idleMinutes" | "napOnBlur" | "blurIdleMinutes">

interface RuleCheck {
  rule: RuleName
  due: boolean
  dueInMs: number
}

// A rule that does not apply to the current focus or options returns undefined.
type Rule = (input: PolicyInput, options: RuleOptions) => RuleCheck | undefined

const MINUTE_MS = 60_000
export const BLUR_DEBOUNCE_MS = 2_000
const MIN_CHECK_MS = 250
const MAX_CHECK_MS = 5_000
const DEFERRED_CHECK_MS = 5_000

function idleMsSince(input: PolicyInput): number {
  return Math.max(0, input.now - input.lastInputAt)
}

const idleRule: Rule = (input, options) => {
  const idleMs = idleMsSince(input)
  const thresholdMs = options.idleMinutes * MINUTE_MS
  return { rule: "idle", due: idleMs >= thresholdMs, dueInMs: Math.max(0, thresholdMs - idleMs) }
}

const blurIdleRule: Rule = (input, options) => {
  if (options.blurIdleMinutes === undefined || input.focus !== "unfocused") return undefined
  const idleMs = idleMsSince(input)
  const thresholdMs = options.blurIdleMinutes * MINUTE_MS
  return { rule: "blurIdle", due: idleMs >= thresholdMs, dueInMs: Math.max(0, thresholdMs - idleMs) }
}

const blurRule: Rule = (input, options) => {
  if (!options.napOnBlur || input.focus !== "unfocused" || input.unfocusedSince === undefined) return undefined
  const unfocusedMs = input.now - input.unfocusedSince
  return { rule: "blur", due: unfocusedMs >= BLUR_DEBOUNCE_MS, dueInMs: Math.max(0, BLUR_DEBOUNCE_MS - unfocusedMs) }
}

// Order is precedence: when several rules are due, the first one listed is reported.
const rules: Rule[] = [idleRule, blurIdleRule, blurRule]

export function decide(input: PolicyInput, options: RuleOptions): Decision {
  const checks = rules.flatMap(rule => {
    const check = rule(input, options)
    return check ? [check] : []
  })
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
