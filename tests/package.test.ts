import { describe, expect, it } from "bun:test"
import { $ } from "bun"

describe("package artifact", () => {
  it("packs the TUI entrypoint with the expected manifest", async () => {
    await $`npm run build`.quiet()
    const output = await $`npm pack --dry-run --json --ignore-scripts`.text()
    const [pack] = JSON.parse(output) as Array<{
      id: string
      files: Array<{ path: string }>
    }>
    const manifest = await Bun.file("package.json").json() as {
      name: string
      exports: Record<string, unknown>
      engines: Record<string, string>
    }

    expect(pack.id).toStartWith("opencode-nap@")
    expect(pack.files.map(file => file.path)).toContain("dist/tui.js")
    expect(pack.files.map(file => file.path)).toContain("dist/tui.d.ts")
    expect(manifest.name).toBe("opencode-nap")
    expect(Object.keys(manifest.exports)).toEqual(["./tui"])
    expect(manifest.engines.opencode).toBe(">=2.2.4")
  }, 30_000)
})
