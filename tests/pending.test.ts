import { describe, expect, it } from "bun:test"
import { createPendingWrites } from "../src/pending.js"

describe("createPendingWrites", () => {
  it("settles at once with no writes, and returns each tracked write unchanged", async () => {
    const pending = createPendingWrites()
    expect(await pending.settled()).toBe(true)
    const write = Promise.resolve(1)
    expect(pending.track(write)).toBe(write)
  })

  it("waits for every write, including one that fails", async () => {
    const pending = createPendingWrites()
    let finish = () => {}
    void pending.track(new Promise<void>(done => { finish = done }))
    void pending.track(Promise.reject(new Error("disk full"))).catch(() => {})
    const settled = pending.settled()
    finish()
    expect(await settled).toBe(true)
  })

  it("gives up on a write that outlasts the limit, and waits again next time", async () => {
    const pending = createPendingWrites(20)
    let finish = () => {}
    void pending.track(new Promise<void>(done => { finish = done }))
    expect(await pending.settled()).toBe(false)
    finish()
    expect(await pending.settled()).toBe(true)
  })
})
