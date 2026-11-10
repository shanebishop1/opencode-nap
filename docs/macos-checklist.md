# macOS checklist

Run this checklist by hand on a Mac, once in Terminal.app and once in one other terminal (iTerm2 or Ghostty). Use the same OpenCode build for both.

For each step, record the terminal name and version, pass or fail, and notes. A step that does not behave as expected is a fail; record what happened.

Restart the OpenCode TUI after each config change. Plugin options are read when the TUI starts.

## Setup

1. Build and pack the plugin from the repository:

   ```sh
   npm run build
   npm pack   # writes opencode-nap-<version>.tgz
   ```

2. Install the tarball into a scratch directory:

   ```sh
   mkdir -p "$HOME/nap-check" && cd "$HOME/nap-check"
   npm init -y >/dev/null
   npm install /abs/path/to/opencode-nap-<version>.tgz
   ```

   The installed package is at `$HOME/nap-check/node_modules/opencode-nap`.

3. Back up your TUI plugin config, then point it at the installed package with a short idle time and a debug log. If `cli.json` does not exist yet, skip the backup.

   ```sh
   cp ~/.config/opencode/cli.json ~/.config/opencode/cli.json.bak
   ```

   Edit `~/.config/opencode/cli.json` so that `plugins` contains:

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

   Use the absolute path. `package` must point at the installed directory.

## Steps

4. **Load.** Start `opencode` and open a session.
   - Expect: the TUI starts and shows the session.
   - Expect: `nap.log` exists. It has one JSON line per event. A line with `"message":"loaded"` shows the plugin loaded, and a line with `"message":"watching"` shows it is ready to nap.
   - Result:

5. **Nap and memory.** Find the TUI's process ID, for example with `ps -axo pid,rss,command | grep '[o]pencode'`. Record its memory with `ps -o rss= -p <pid>`. Do not touch the window for about 30 seconds.
   - Expect: the window clears and shows the session title and `Napping to save memory. Press any key or click to wake.`
   - Expect: the process ID is the same as before the nap.
   - Expect: napped, the RSS is a few MB, far below the awake value. On Linux it drops from about 150 MB to about 2 MB. `ps` reports KB.
   - Expect: `pgrep -P <pid>` lists one child, the `dd` process. Its `ps -o rss=` value is small.
   - Result (record both RSS values):

6. **Wake by key.** Press Space.
   - Expect: the session returns within about 2 seconds.
   - Expect: the Space is not typed into the prompt.
   - Result:

7. **Wake by click.** Nap again. Click inside the window.
   - Expect: the session returns.
   - Expect: the click does nothing inside OpenCode, such as selecting text or opening a link.
   - Result:

8. **Draft carried.** Type at least three lines, including a non-ASCII character such as `café`. Do not send them. Nap, then wake.
   - Expect: the same text returns with its line breaks, and the cursor is at the end.
   - Expect: no message was sent, so the transcript is unchanged.
   - Result:

9. **Nap on blur.** Set `"napOnBlur": true` and `"idleMinutes": 15`. Restart the TUI. Click another application, such as Finder, and stay there.
   - Expect: the window naps about 2 seconds after you leave it.
   - Expect: back in the window, it stays napped. Focus does not wake it. Wake it with a key.
   - If the window never naps, the terminal may not report focus. Record that as the result.
   - Result:

10. **Quick switch does not nap.** Switch to another application and back within about 1 second.
    - Expect: the window does not nap.
    - Result:

11. **Mid-run nap.** This step and the next need a working model provider. Set `"napOnBlur": false` and `"idleMinutes": 0.25` again. Restart the TUI. Ask for a long answer, such as an essay of several thousand words. Do not touch the window while it streams.
    - Expect: the window naps while the reply is still streaming.
    - Wait about a minute, then wake with a key.
    - Expect: the reply is complete, with no truncation or error.
    - Result:

12. **Permission prompt after wake.** In your OpenCode config, add `{ "action": "shell", "resource": "*", "effect": "ask" }` to `agents.build.permissions`. Restart the TUI. Ask for a shell command to be run, and leave the permission prompt unanswered.
    - Expect: the prompt is pending.
    - Wait for the nap, then wake with a key.
    - Expect: the permission prompt is shown again within about 2 seconds, and the key did not answer it.
    - Answer the prompt. Expect the run continues.
    - Result:

13. **Background service.** Start `opencode` with no `--server` flag. Repeat steps 5 and 6.
    - Result:

14. **Named server.** Start a server with `opencode serve`. It prints `server listening on http://…`; note that URL. Start `opencode --server <url>`. Repeat steps 5 and 6.
    - Result:

15. **Log.** Open `nap.log` and search it for text you typed in step 8.
    - Expect: no line contains the draft text.
    - Result:

16. **Clean up.** Restore your config from the backup, or delete `cli.json` if there was none, then remove the scratch directory:

    ```sh
    mv ~/.config/opencode/cli.json.bak ~/.config/opencode/cli.json
    rm -rf "$HOME/nap-check"
    ```

    Undo the permission rule from step 12. Stop any server you started in step 14.
    - Result:

17. **Record the terminals.** List the terminals you checked, with their versions, in the "Platforms" section of the README. Replace the line that says none yet.
    - Result:
