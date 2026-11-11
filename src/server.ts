import type { Plugin } from "@opencode/plugin"
import { optionsRpc } from "./options-rpc.js"

const plugin = {
  id: "opencode-nap",
  async setup(context) {
    const registration = await context.rpc.register(optionsRpc, {
      options: async () => context.options,
    })
    return () => registration.dispose()
  },
} satisfies Plugin.Plugin

export default plugin
