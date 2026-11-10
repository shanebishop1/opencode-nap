import { z } from "zod"

export interface NapOptions {
  enabled: boolean
  idleMinutes: number
  napOnBlur: boolean
  blurIdleMinutes: number | undefined
  carryDraft: boolean
}

export const defaults: NapOptions = {
  enabled: true,
  idleMinutes: 15,
  napOnBlur: false,
  blurIdleMinutes: undefined,
  carryDraft: true,
}

export type ParsedOptions = { ok: true; options: NapOptions } | { ok: false; message: string }

const minutes = z.number().finite().positive()

const schema = z
  .object({
    enabled: z.boolean().optional(),
    idleMinutes: minutes.optional(),
    napOnBlur: z.boolean().optional(),
    blurIdleMinutes: minutes.optional(),
    carryDraft: z.boolean().optional(),
  })
  .strict()

const expected: Record<keyof NapOptions, string> = {
  enabled: "must be true or false",
  idleMinutes: "must be a number greater than 0",
  napOnBlur: "must be true or false",
  blurIdleMinutes: "must be a number greater than 0",
  carryDraft: "must be true or false",
}

function describeIssue(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const names = issue.keys.map(key => `"${key}"`).join(", ")
    return issue.keys.length === 1 ? `unknown option ${names}` : `unknown options ${names}`
  }

  const [key] = issue.path
  if (typeof key !== "string") return "invalid options: must be an object"
  return `invalid option "${key}": ${expected[key as keyof NapOptions]}`
}

export function parseOptions(raw: unknown): ParsedOptions {
  if (raw === undefined || raw === null) return { ok: true, options: { ...defaults } }

  const result = schema.safeParse(raw)
  if (!result.success) return { ok: false, message: describeIssue(result.error.issues[0]) }

  const data = result.data
  return {
    ok: true,
    options: {
      enabled: data.enabled ?? defaults.enabled,
      idleMinutes: data.idleMinutes ?? defaults.idleMinutes,
      napOnBlur: data.napOnBlur ?? defaults.napOnBlur,
      blurIdleMinutes: data.blurIdleMinutes,
      carryDraft: data.carryDraft ?? defaults.carryDraft,
    },
  }
}
