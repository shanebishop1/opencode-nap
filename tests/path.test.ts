import { describe, expect, it } from "bun:test"
import { abbreviateHome, truncatePath } from "../src/path.js"

describe("abbreviateHome", () => {
  it("shortens the home directory and what is below it", () => {
    expect(abbreviateHome("/home/shane", "/home/shane")).toBe("~")
    expect(abbreviateHome("/home/shane/work/app", "/home/shane")).toBe("~/work/app")
    expect(abbreviateHome("/home/shane/work", "/home/shane/")).toBe("~/work")
  })

  it("leaves other directories alone", () => {
    expect(abbreviateHome("/home/shaneb/work", "/home/shane")).toBe("/home/shaneb/work")
    expect(abbreviateHome("/srv/app", "/home/shane")).toBe("/srv/app")
    expect(abbreviateHome("/srv/app", "")).toBe("/srv/app")
  })
})

describe("truncatePath", () => {
  it("keeps a path that fits", () => {
    expect(truncatePath("~/work/app", 10)).toBe("~/work/app")
  })

  it("keeps the last segments that fit behind an ellipsis", () => {
    expect(truncatePath("~/code/work/app", 12)).toBe("…/work/app")
    expect(truncatePath("/a/b/c/d", 6)).toBe("…/c/d")
  })

  it("cuts the last segment when even it does not fit", () => {
    expect(truncatePath("/srv/a-long-project-name", 8)).toBe("a-long-…")
  })
})
