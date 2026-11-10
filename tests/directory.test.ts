import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { directoryResolver, sameDirectory } from "../src/directory.js"

describe("directoryResolver", () => {
  const start = { cwd: "/real/project", pwd: "/home/me", sameDirectory: (a: string, b: string) => a === "/home/me/project" && b === "/real/project" }

  it("keeps an absolute directory argument", () => {
    expect(directoryResolver(start)("/somewhere/else")).toBe("/somewhere/else")
  })

  it("resolves a relative one against the shell's directory when that names the same directory", () => {
    expect(directoryResolver(start)("project")).toBe("/home/me/project")
  })

  it("otherwise uses the directory OpenCode changed into", () => {
    expect(directoryResolver(start)("../other")).toBe("/real/project")
    expect(directoryResolver({ ...start, pwd: undefined })("project")).toBe("/real/project")
    expect(directoryResolver({ ...start, pwd: "relative" })("project")).toBe("/real/project")
  })

  it("sameDirectory compares real directories, through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-nap-directory-"))
    try {
      await mkdir(join(root, "real"))
      await symlink(join(root, "real"), join(root, "link"))
      expect(sameDirectory(join(root, "link"), join(root, "real"))).toBe(true)
      expect(sameDirectory(join(root, "real"), root)).toBe(false)
      expect(sameDirectory(join(root, "missing"), root)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
