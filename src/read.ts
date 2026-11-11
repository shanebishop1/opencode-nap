export const isObject = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null

/** Walks a dotted path to the value it names, or undefined. */
export function read(root: unknown, path: string): unknown {
  let value = root
  for (const key of path.split(".")) {
    if (!isObject(value)) return undefined
    value = value[key]
  }
  return value
}
