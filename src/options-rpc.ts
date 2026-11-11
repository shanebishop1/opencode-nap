import type { Rpc } from "@opencode/plugin/rpc"

export const optionsRpc = {
  id: "opencode-nap",
  methods: {
    options: {
      input: { type: "null" },
      output: { type: "object" },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition
