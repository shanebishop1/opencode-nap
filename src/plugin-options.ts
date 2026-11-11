import type { Plugin } from "@opencode/plugin/tui"
import { optionsRpc } from "./options-rpc.js"

export async function pluginOptions(context: Plugin.Context): Promise<unknown> {
  const local: unknown = context.options
  // cli.json owns the window's options when it supplies any.
  if (local !== undefined && local !== null && (typeof local !== "object" || Array.isArray(local) || Object.keys(local).length > 0)) return local

  try {
    return await context.client.rpc(optionsRpc).options(null, {
      location: context.location ?? context.data.location.default(),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    // TUI-only installs have no server part. Other failures must not hide enabled: false.
    if (typeof error === "object" && error !== null && "type" in error && error.type === "rpc.unavailable") return local
    throw error
  }
}
