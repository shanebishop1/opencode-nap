import { takeWidth, textWidth } from "./text.js"

/** `~` for the home directory and `~/…` below it, as OpenCode shows it. */
export function abbreviateHome(directory: string, home: string): string {
  if (!home) return directory
  const root = home.replace(/\/+$/, "")
  if (directory === root) return "~"
  return directory.startsWith(`${root}/`) ? `~${directory.slice(root.length)}` : directory
}

/** Keeps the last segments of a path that fit in `max` cells, behind an ellipsis. */
export function truncatePath(path: string, max: number): string {
  if (textWidth(path) <= max) return path
  const segments = path.split("/").filter(Boolean)
  const basename = segments[segments.length - 1] ?? path
  let kept = ""
  for (const segment of segments.reverse()) {
    const next = `/${segment}${kept}`
    if (textWidth(`…${next}`) > max) break
    kept = next
  }
  return kept ? `…${kept}` : takeWidth(basename, max)
}
