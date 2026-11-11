# macOS checklist

Not run yet. Check at least one terminal, such as Ghostty or iTerm2.

Record macOS, OpenCode and terminal versions, results, timings and notes.

Edit only the scratch `cli.json`; restart the TUI after each plugin option change.

## Setup

1. From the repository, build and pack into a new scratch directory:

   ```sh
   bun install --frozen-lockfile
   npm run build
   repo=$PWD
   scratch=$(mktemp -d "${TMPDIR:-/tmp}/nap-check.XXXXXX")
   npm pack --pack-destination "$scratch"
   ```

2. Enter a clean test shell. Never use your own config, credentials or service. Keep every launch below in this shell:

   ```sh
   mkdir -p "$scratch/home" "$scratch/config/opencode" "$scratch/data" "$scratch/state" \
     "$scratch/cache" "$scratch/run" "$scratch/tmp" "$scratch/project"
   chmod 700 "$scratch/run"
   password=$(openssl rand -hex 24)
   env -i PATH="$PATH" TERM=xterm-256color HOME="$scratch/home" \
     XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data" \
     XDG_STATE_HOME="$scratch/state" XDG_CACHE_HOME="$scratch/cache" \
     XDG_RUNTIME_DIR="$scratch/run" TMPDIR="$scratch/tmp" \
     OPENCODE_CONFIG="$scratch/project/opencode.json" \
     OPENCODE_PASSWORD="$password" OPENCODE_SERVER_PASSWORD="$password" \
     OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
     OPENCODE_DISABLE_FREE_MODELS=1 NAP_CHECK_REPO="$repo" \
     NAP_CHECK_ROOT="$scratch" /bin/sh
   cd "$NAP_CHECK_ROOT/project"
   npm init -y >/dev/null
   npm install "$NAP_CHECK_ROOT"/opencode-nap-*.tgz @opencode/cli@2.2.4
   ```

3. Start the existing [local provider fixture](../tests/fixtures/local-openai-server.ts):

   ```sh
   bun "$NAP_CHECK_REPO/tests/fixtures/local-openai-server.ts" \
     "$NAP_CHECK_ROOT/provider.jsonl" 45 1000 >"$NAP_CHECK_ROOT/provider.out" 2>&1 &
   provider_pid=$!
   ```

   Wait for `READY http://127.0.0.1:…` in `provider.out`. Substitute that URL below. This reuses the [test configuration](../tests/e2e/fake-provider.ts), which denies every provider except the local fake and makes shell permissions ask:

   ```sh
   bun -e '
     const root = process.env.NAP_CHECK_ROOT
     const { fakeProviderConfig } = await import(process.env.NAP_CHECK_REPO + "/tests/e2e/fake-provider.ts")
     await Bun.write(process.env.OPENCODE_CONFIG, JSON.stringify(fakeProviderConfig(Bun.argv.at(-1))))
     await Bun.write(root + "/config/opencode/cli.json", JSON.stringify({ plugins: [{
       package: root + "/project/node_modules/opencode-nap",
       options: { idleMinutes: 0.25, debugLogFile: root + "/nap.log" }
     }] }))
   ' 'http://127.0.0.1:<provider-port>'
   ./node_modules/.bin/opencode serve --hostname 127.0.0.1 --port 0 \
     >"$NAP_CHECK_ROOT/server.out" 2>&1 &
   server_pid=$!
   ```

   Wait for `server listening on http://…` in `server.out`. For every TUI start/restart below, use `./node_modules/.bin/opencode --server <that-url> .`, not bare `opencode`. Do not configure a hosted provider. These steps follow the isolation in [the test harness](../tests/e2e/harness.ts); only step 13 may use a default service.

   Never press Enter to submit a prompt or answer a permission in the TUI. For steps 11–12, use only the scratch private server API, with Basic authentication and the `x-opencode-directory` header as in [`callApi`](../tests/e2e/harness.ts). The [run tests](../tests/e2e.run.test.ts) show the exact calls: submit with `POST /api/session/<sessionID>/prompt` and `{ "text": "NAP_SLOW" }` or `{ "text": "NAP_PERM" }`; get the pending permission ID with `GET /api/session/<sessionID>/permission`, then answer with `POST /api/session/<sessionID>/permission/<permissionID>/reply` and `{ "decision": "once" }`. Keep the scratch password out of output and logs.

## Steps

4. **Load.** Start the TUI against the private server and open a session.
   - Expect: the session appears and `nap.log` exists, with JSON lines containing `"message":"loaded"` and `"message":"watching"`.
   - [ ] Result:

5. **Nap and memory.** Use `ps -axo pid,ppid,rss,comm` to record the TUI's PID and RSS, including children but excluding the separate server. Leave it idle for about 30 seconds; measure again.
   - Expect: the window clears and shows the OpenCode logo with the directory below it and `Napping to save memory. Press any key or click to wake.` under that.
   - Expect: the logo's colours and the background match the home screen the TUI shows before the nap; the cursor sits in the box.
   - Expect: the process ID is the same as before the nap.
    - Expect: much lower total RSS. Linux measured about 152 MB awake and 4 MB napped; record macOS values for this terminal. `ps` reports KiB.
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
   - Some terminals do not report focus. Record missing reports as a limitation, not a pass. Ordinary idle nap must still work.
   - [ ] Result:

10. **Quick switch does not nap.** Switch to another application and back within about 1 second.
    - Expect: the window does not nap.
    - Then set `"napOnBlur": false` and `"blurIdleMinutes": 0.25`; restart and leave unfocused. Expect a nap after about 15 idle seconds. Remove `blurIdleMinutes` afterward.
    - [ ] Result:

11. **Mid-run nap.** Set `"napOnBlur": false` and `"idleMinutes": 0.25`; restart. Submit `NAP_SLOW` through the private server API above; the local fake provider streams for 45 seconds.
    - Expect: the window naps while the reply is still streaming.
    - Wait a minute, then wake. Expect the full reply through `NAP_SLOW_DONE`, without error.
    - [ ] Result:

12. **Permission prompt after wake.** Submit `NAP_PERM` through the private server API above. The local fake provider requests a harmless write to `nap-e2e-permission.txt` in the scratch project. Leave permission unanswered.
    - Wait for the nap, then wake with a key.
    - Expect: the permission prompt returns, still unanswered by the wake key.
    - Leave it open for at least 10 seconds, then allow once through the API above, not the TUI. Expect `NAP_PERM_DONE`.
    - [ ] Result:

13. **Background service — isolated account/VM only.** This requires a disposable macOS account or VM with no unrelated service. Repeat the scratch setup there. Immediately before starting the default service, prove ports 49374 and 49375 are idle: `lsof -nP -iTCP:49374 -iTCP:49375 -sTCP:LISTEN` must show no listeners, and `nc -vz <address> <port>` must report connection refused for both ports on both `127.0.0.1` and `::1`. Only then start `./node_modules/.bin/opencode .` without `--server`; repeat steps 5 and 6. If isolation or port checks are uncertain, mark **not run**. Never probe by starting a service on your everyday account.
    - [ ] Result:

14. **Named server.** Using the private server from setup, repeat steps 5 and 6. Confirm the server PID stays unchanged across nap and wake.
    - [ ] Result:

15. **Log.** Open `nap.log` and search it for text you typed in step 8.
    - Expect: no line contains the draft text.
    - [ ] Result:

16. **Clean up.** Quit test TUIs; stop only the fixture/server you started with `kill "$provider_pid" "$server_pid"`, then `wait "$provider_pid" "$server_pid"`. Stop any service created in the disposable account/VM. Exit the clean shell; from its parent, run `rm -rf -- "$scratch"` and `unset password`. Remove this run's repository `dist/`, and repository `node_modules/` only if created for this check. Do not restore or edit your own configs: none were used.
    - [ ] Result:

17. **Record the terminals.** Replace "none yet" in the README with actual terminal versions, results and focus limitations. Do not claim unrun checks passed.
    - [ ] Result:
