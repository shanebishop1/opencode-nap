import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { optionsRpc } from "../src/options-rpc.js"
import server from "../src/server.js"

describe("server part", () => {
  it("exposes its raw options without filtering invalid values, and disposes its RPC", async () => {
    const options = { enabled: false, idleMinutes: "invalid", unknown: true }
    let disposed = false
    const context = {
      options,
      rpc: {
        async register(definition: unknown, handlers: { options(): Promise<unknown> }) {
          expect(definition).toBe(optionsRpc)
          expect(await handlers.options()).toBe(options)
          return { dispose: async () => { disposed = true } }
        },
      },
    } as unknown as Plugin.Context
    expect(server.id).toBe("opencode-nap")
    const cleanup = await server.setup(context)
    expect(disposed).toBe(false)
    await cleanup()
    expect(disposed).toBe(true)
  })
})
