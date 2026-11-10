import type { Plugin } from "@opencode/plugin/tui"
import { createLog } from "./log.js"

// A plain definition rather than Plugin.define (an identity helper), so the
// packed plugin has no runtime dependency on @opencode/plugin.
const plugin = {
  id: "opencode-nap",
  setup(context) {
    const log = createLog(context.options.debugLogFile)
    log.write("loaded", { options: context.options })
    return () => {}
  },
} satisfies Plugin.Definition

export default plugin
