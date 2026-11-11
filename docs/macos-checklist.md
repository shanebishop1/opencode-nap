# macOS checklist

Not run yet. Check Terminal.app and one other terminal (iTerm2 or Ghostty) on the same OpenCode build.

Record macOS, OpenCode and terminal versions, results, timings and notes.

Restart the TUI after each plugin option change.

## Setup

1. Build and pack from the repository:

   ```sh
   bun install --frozen-lockfile
   npm run build
   npm pack   # writes opencode-nap-<version>.tgz
   ```

2. Install into a new scratch directory; do not reuse an existing `~/nap-check`:

   ```sh
   mkdir "$HOME/nap-check" && cd "$HOME/nap-check"
   npm init -y >/dev/null
   npm install /abs/path/to/opencode-nap-<version>.tgz
   ```

3. Use a test OpenCode setup. Back up `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json` if set), without overwriting an existing backup. Note if it did not exist. Preserve other settings and add:

   ```json
   {
     "plugins": [
       {
         "package": "/Users/<you>/nap-check/node_modules/opencode-nap",
         "options": {
           "idleMinutes": 0.25,
           "debugLogFile": "/Users/<you>/nap-check/nap.log"
         }
       }
     ]
   }
   ```

   Substitute your absolute installed-directory path. The bare name works only after npm publication.

## Steps

4. **Load.** Start `opencode` and open a session.
   - Expect: the session appears and `nap.log` exists, with JSON lines containing `"message":"loaded"` and `"message":"watching"`.
   - [ ] Result:

5. **Nap and memory.** Use `ps -axo pid,ppid,rss,comm` to record the TUI's PID and RSS, including children but excluding the separate server. Leave it idle for about 30 seconds; measure again.
   - Expect: the window clears and shows the session title and `Napping to save memory. Press any key or click to wake.`
   - Expect: the process ID is the same as before the nap.
   - Expect: much lower total RSS. Linux measured about 152 MB awake and 4 MB napped; macOS values need measuring. `ps` reports KiB.
   - Include the `dd` reader listed by `pgrep -P <pid>` in the total.
   - [ ] Result (awake and napped totals, process counts, time to nap):

6. **Wake by key.** Press Space.
   - Expect: the same session returns without Space in the prompt. Record time to an interactive prompt; Linux measured about 1.5 seconds.
   - [ ] Result:

7. **Wake by click.** Nap again. Click inside the window.
   - Expect: the same session returns without the click acting inside OpenCode.
   - [ ] Result:

8. **Draft carried.** Paste at least three lines, including `café`, into the prompt. Do not send them. Nap, then wake.
   - Expect: the text and line breaks return, cursor at the end. Nothing was sent.
   - [ ] Result:

9. **Nap on blur.** Set `"napOnBlur": true` and `"idleMinutes": 15`. Restart; switch to Finder and stay there.
   - Expect: the window naps about 2 seconds after you leave it.
   - Expect: switching back does not wake it; a key does.
   - Terminal.app may not report focus. Record missing reports as a limitation, not a pass. Ordinary idle nap must still work.
   - [ ] Result:

10. **Quick switch does not nap.** Switch to another application and back within about 1 second.
    - Expect: the window does not nap.
    - Then set `"napOnBlur": false` and `"blurIdleMinutes": 0.25`; restart and leave unfocused. Expect a nap after about 15 idle seconds. Remove `blurIdleMinutes` afterward.
    - [ ] Result:

11. **Mid-run nap.** This and the next step need a model provider. Set `"napOnBlur": false` and `"idleMinutes": 0.25`; restart. Ask for a long answer; leave it streaming.
    - Expect: the window naps while the reply is still streaming.
    - Wait a minute, then wake. Expect the reply to have continued without error. If it finished before nap, repeat with a longer run.
    - [ ] Result:

12. **Permission prompt after wake.** Back up the test server's config; add `{ "action": "shell", "resource": "*", "effect": "ask" }` to `agents.build.permissions`. Restart the test server and TUI. Request a harmless shell command; leave permission unanswered. Paste a draft before the dialog appears.
    - Wait for the nap, then wake with a key.
    - Expect: the permission prompt returns, still unanswered by the wake key.
    - Leave it open for at least 10 seconds, then answer. Expect the run to continue and the draft to return when the prompt box reappears.
    - [ ] Result:

13. **Background service.** Start `opencode` without `--server` in the test setup. Do not replace an unrelated service. Repeat steps 5 and 6.
    - [ ] Result:

14. **Named server.** Run `opencode serve --hostname 127.0.0.1 --port 0`; note the URL in `server listening on http://…`. Start `opencode --server <url>`; repeat steps 5 and 6.
    - [ ] Result:

15. **Log.** Open `nap.log` and search it for text you typed in step 8.
    - Expect: no line contains the draft text.
    - [ ] Result:

16. **Clean up.** Stop test TUIs and servers. Restore configs; remove a config only if you created it. Remove this run's scratch install, log, tarball and `dist/`. Remove `node_modules/` only if created for this check. Keep unrelated work.
    - [ ] Result:

17. **Record the terminals.** Replace "none yet" in the README with actual terminal versions, results and focus limitations. Do not claim unrun checks passed.
    - [ ] Result:
