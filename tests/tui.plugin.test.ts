import { describe, expect, it, spyOn } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import plugin from "../src/tui.js"

describe("tui plugin", () => {
  it("exports a definition with the opencode-nap id and a setup function", () => {
    expect(plugin.id).toBe("opencode-nap")
    expect(typeof plugin.setup).toBe("function")
  })

  it("logs its options and returns a cleanup function", () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const context = { options: { enabled: true } } as unknown as Plugin.Context
      const cleanup = plugin.setup(context)

      expect(typeof cleanup).toBe("function")
      expect(() => (cleanup as () => void)()).not.toThrow()
      expect(error).toHaveBeenCalledWith("[opencode-nap] loaded", { enabled: true })
    } finally {
      error.mockRestore()
    }
  })
})
