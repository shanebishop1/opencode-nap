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
const BLUR_DEBOUNCE_MS = 2_000
const MIN_CHECK_MS = 250
const MAX_CHECK_MS = 5_000
const DEFERRED_CHECK_MS = 5_000

const after = (rule: RuleName, elapsedMs: number, thresholdMs: number): RuleCheck =>
  ({ rule, due: elapsedMs >= thresholdMs, dueInMs: Math.max(0, thresholdMs - elapsedMs) })

const idleMs = (input: PolicyInput): number => Math.max(0, input.now - input.lastInputAt)

const idleRule: Rule = (input, options) => after("idle", idleMs(input), options.idleMinutes * MINUTE_MS)

const blurIdleRule: Rule = (input, options) => {
  if (options.blurIdleMinutes === undefined || input.focus !== "unfocused") return undefined
  return after("blurIdle", idleMs(input), options.blurIdleMinutes * MINUTE_MS)
}

const blurRule: Rule = (input, options) => {
  if (!options.napOnBlur || input.focus !== "unfocused" || input.unfocusedSince === undefined) return undefined
  return after("blur", input.now - input.unfocusedSince, BLUR_DEBOUNCE_MS)
}

// Order is precedence: when several rules are due, the first one listed is reported.
const rules: Rule[] = [idleRule, blurIdleRule, blurRule]

export function decide(input: PolicyInput, options: RuleOptions): Decision {
  const checks = rules.flatMap(rule => rule(input, options) ?? [])
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
