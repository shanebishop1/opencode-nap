import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { optionsRpc } from "../src/options-rpc.js"
import { pluginOptions } from "../src/plugin-options.js"

const context = (options: unknown, read: (...args: unknown[]) => Promise<unknown>, location?: { directory: string }) => ({
  options,
  location,
  client: {
    rpc(definition: unknown) {
      expect(definition).toBe(optionsRpc)
      return { options: read }
    },
  },
  data: { location: { default: () => ({ directory: "/default-project" }) } },
}) as unknown as Plugin.Context

describe("plugin options", () => {
  it("reads current server options at the TUI's location", async () => {
    const location = { directory: "/project" }
    const options = { idleMinutes: 0.1, enabled: false }
    const host = context({}, async (input, request) => {
      expect(input).toBeNull()
      expect(request).toMatchObject({ location, signal: expect.any(AbortSignal) })
      return options
    }, location)
    expect(await pluginOptions(host)).toBe(options)
  })

  it("uses the default location when none is selected", async () => {
    const host = context({}, async (_input, request) => {
      expect(request).toMatchObject({ location: { directory: "/default-project" } })
      return {}
    })
    expect(await pluginOptions(host)).toEqual({})
  })

  it("lets nonempty cli.json options win without contacting the server", async () => {
    const options = { enabled: false }
    const host = context(options, async () => { throw new Error("must not be called") })
    expect(await pluginOptions(host)).toBe(options)
  })

  it("leaves invalid local options for the existing fail-closed parser", async () => {
    for (const options of [false, "invalid", { unknown: true }, [], ["invalid"]]) {
      expect(await pluginOptions(context(options, async () => { throw new Error("must not be called") }))).toBe(options)
    }
  })

  it("uses defaults for a TUI-only installation with no server RPC", async () => {
    for (const options of [{}, undefined, null]) {
      const host = context(options, async () => { throw { type: "rpc.unavailable", message: "not registered" } })
      expect(await pluginOptions(host)).toBe(options)
    }
  })

  it("does not silently use defaults when the server options cannot be read", async () => {
    for (const error of [new Error("disconnected"), { type: "rpc.internal" }, { type: "rpc.invalid_output" }]) {
      const host = context({}, async () => { throw error })
      await expect(pluginOptions(host)).rejects.toBe(error)
    }
  })
})
