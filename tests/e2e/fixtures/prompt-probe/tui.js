// Test-only TUI plugin for the end-to-end suite. It reports the session
// prompt's text and cursor, and can set the prompt's text, through control
// files the test writes. It never submits anything.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const isPrompt = editor =>
  editor && editor.traits?.owner === "opencode" && editor.traits?.role === "prompt" && typeof editor.setText === "function"

export default {
  id: "prompt-probe",
  setup(api) {
    const { log, ctl } = api.options
    const write = entry => appendFileSync(log, `${JSON.stringify({ time: Date.now(), ...entry })}\n`)
    const take = name => {
      const file = join(ctl, name)
      if (!existsSync(file)) return undefined
      const content = readFileSync(file, "utf8")
      rmSync(file)
      return content
    }
    const timer = setInterval(() => {
      try {
        const editor = api.renderer.currentFocusedEditor
        const set = take("set")
        if (set !== undefined) {
          if (isPrompt(editor)) {
            editor.setText(set)
            editor.gotoBufferEnd()
          }
          write({ phase: "set", ok: isPrompt(editor), length: set.length })
        }
        if (take("report") !== undefined) {
          const text = isPrompt(editor) ? editor.plainText : undefined
          write({
            phase: "report",
            prompt: isPrompt(editor),
            length: text?.length,
            sha256: text === undefined ? undefined : createHash("sha256").update(text).digest("hex"),
            text: text !== undefined && text.length <= 4096 ? text : undefined,
            cursorOffset: isPrompt(editor) ? editor.cursorOffset : undefined,
            logicalCursor: isPrompt(editor) ? editor.logicalCursor : undefined,
          })
        }
      } catch (error) {
        write({ phase: "error", error: String(error) })
      }
    }, 100)
    timer.unref?.()
    return () => clearInterval(timer)
  },
}
