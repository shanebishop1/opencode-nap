import { describe, expect, it } from "bun:test"
import { probe } from "../src/probe.js"
import { fakeContext, FakeEmitter } from "./fakes.js"

describe("probe", () => {
  it("passes a context with every internal the plugin uses", () => {
    const stdin = new FakeEmitter()
    const context = fakeContext(stdin)
    expect(probe(context, stdin)).toEqual({ ok: true, host: context as never, stdin })
  })

  it("names the first missing internal", () => {
    const stdin = new FakeEmitter()
    const cases: Array<[string, (context: any) => void]> = [
      ["ui.router.current", context => { context.ui = undefined }],
      ["client.server.info", context => { context.client.server.info = {} }],
      ["data.session.get", context => { delete context.data.session }],
      ["renderer.on/off", context => { context.renderer.on = undefined }],
      ["renderer.keyInput.on/off", context => { context.renderer.keyInput = { on() {} } }],
      ["renderer.controlState", context => { delete context.renderer.controlState }],
      ["renderer.stdin", context => { context.renderer.stdin = new FakeEmitter() }],
    ]
    for (const [name, remove] of cases) {
      const context = fakeContext(stdin)
      remove(context)
      expect(probe(context, stdin)).toEqual({ ok: false, missing: name })
    }
    expect(probe(undefined, stdin)).toEqual({ ok: false, missing: "ui.router.current" })
  })

  it("treats a getter that throws as missing", () => {
    const stdin = new FakeEmitter()
    const context = fakeContext(stdin)
    Object.defineProperty(context.renderer, "keyInput", { get: () => { throw new Error("destroyed") } })
    expect(probe(context, stdin)).toEqual({ ok: false, missing: "renderer.keyInput.on/off" })
  })

  it("requires the input stream to be an emitter", () => {
    const context = fakeContext(new FakeEmitter())
    context.renderer.stdin = {} as never
    expect(probe(context, {})).toEqual({ ok: false, missing: "renderer.stdin" })
  })
})
