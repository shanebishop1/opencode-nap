import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-nap",
  setup(context) {
    console.error("[opencode-nap] loaded", context.options)
    return () => {}
  },
})
