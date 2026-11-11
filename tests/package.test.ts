import { describe, expect, it } from "bun:test"
import { $ } from "bun"

describe("package artifact", () => {
  it("packs the server and TUI entrypoints with the expected manifest", async () => {
    await $`npm run build`.quiet()
    const output = await $`npm pack --dry-run --json --ignore-scripts`.text()
    const [pack] = JSON.parse(output) as Array<{
      id: string
      files: Array<{ path: string }>
    }>
    const manifest = await Bun.file("package.json").json() as {
      name: string
      exports: Record<string, unknown>
      dependencies: Record<string, string>
      engines: Record<string, string>
    }

    expect(pack.id).toStartWith("opencode-nap@")
    expect(pack.files.map(file => file.path)).toContain("dist/tui.js")
    expect(pack.files.map(file => file.path)).toContain("dist/tui.d.ts")
    expect(pack.files.map(file => file.path)).toContain("dist/server.js")
    expect(pack.files.map(file => file.path)).toContain("dist/server.d.ts")
    expect(manifest.name).toBe("opencode-nap")
    expect(Object.keys(manifest.exports)).toEqual([".", "./tui"])
    expect(manifest.engines.opencode).toBe(">=2.2.4")
    expect(manifest.dependencies).not.toHaveProperty("@opencode/plugin")
    expect(await Bun.file("dist/tui.js").text()).not.toMatch(/from\s+["']@opencode\/plugin/)
    expect(await Bun.file("dist/server.js").text()).not.toMatch(/from\s+["']@opencode\/plugin/)

    const tui = await import("opencode-nap/tui")
    expect(tui.default.id).toBe("opencode-nap")
    expect(typeof tui.default.setup).toBe("function")
    const server = await import("opencode-nap")
    expect(server.default.id).toBe(tui.default.id)
    expect(typeof server.default.setup).toBe("function")
  }, 30_000)
})
