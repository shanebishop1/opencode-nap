// A TUI plugin the end-to-end tests load next to opencode-nap. It reports
// what the TUI shows and does what a test asks, so tests never type into an
// awake TUI.
//
// Options: { logFile, controlDir }. Every report is one JSON line in logFile.
// A test drops a file named after a request into controlDir; the plugin
// handles it, deletes it and logs the result:
//   state         route, open tabs, the stored value and the prompt's text
//   tab           opens the session ID in the file as a tab
//   store         stores the file's text in plugin storage
//   history-back  recalls the previous prompt from history
//   clear         empties the prompt
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const attempt = (read) => {
  try {
    return read()
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

export default {
  id: "nap-e2e-observer",
  setup(api) {
    const { logFile, controlDir } = api.options ?? {}
    const log = (event, detail = {}) => {
      try {
        appendFileSync(logFile, `${JSON.stringify({ time: Date.now(), pid: process.pid, event, ...detail })}\n`)
      } catch {
        // Reports are best effort.
      }
    }
    const renderer = api.renderer
    const [stored, setStored] = api.storage.store("nap-e2e-observer", { initial: { value: null } })
    const prompt = () => {
      const focused = renderer.currentFocusedRenderable
      return focused && typeof focused.setText === "function" ? focused : undefined
    }
    const state = () => ({
      route: attempt(() => api.ui.router.current()),
      tabs: attempt(() => api.ui.tabs.list().map(tab => tab.sessionID)),
      stored: attempt(() => stored.value),
      prompt: attempt(() => prompt()?.plainText ?? null),
    })
    log("setup", { argv: process.argv.slice(2), ...state() })

    // The prompt is interactive once its editor has focus.
    const ready = setInterval(() => {
      const editor = prompt()
      if (!editor) return
      clearInterval(ready)
      log("interactive", { prompt: editor.plainText })
    }, 10)

    const handlers = {
      state: () => state(),
      tab: sessionID => ({ opened: attempt(() => api.ui.tabs.open(sessionID)) }),
      store: async value => {
        await setStored(draft => {
          draft.value = value
        })
        return { stored: stored.value }
      },
      "history-back": () => {
        api.keymap.dispatch("prompt.history.previous")
        return {}
      },
      clear: () => {
        prompt()?.setText("")
        return { prompt: prompt()?.plainText ?? null }
      },
    }
    let busy = false
    const control = setInterval(async () => {
      if (busy || !controlDir) return
      busy = true
      try {
        for (const [name, handle] of Object.entries(handlers)) {
          const file = join(controlDir, name)
          if (!existsSync(file)) continue
          const input = readFileSync(file, "utf8").trim()
          rmSync(file)
          log(name, { input, result: await handle(input) })
        }
      } catch (error) {
        log("error", { error: String(error) })
      } finally {
        busy = false
      }
    }, 100)

    return () => {
      clearInterval(ready)
      clearInterval(control)
    }
  },
}
