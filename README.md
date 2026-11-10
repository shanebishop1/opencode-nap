# opencode-nap

An OpenCode 2 TUI plugin that naps idle windows to save memory, then wakes them into the same session on a key press or click.

On Linux, a napping window drops from about 150 MB to about 4 MB. Runs keep going in the OpenCode server while a window naps, including runs that are still streaming. Unsent prompt text comes back after wake.

## Install

The plugin needs OpenCode 2.2.4 or later.

OpenCode 2 TUI plugins are listed in `cli.json`, not `opencode.json`. The file is `$XDG_CONFIG_HOME/opencode/cli.json`, usually `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-nap"]
}
```

To set options, use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode-nap",
      "options": { "idleMinutes": 10, "napOnBlur": true }
    }
  ]
}
```

A package name is installed from npm. `package` can also be the absolute path of an installed package directory.

## Options

| Option            | Default | Meaning                                                                                         |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `enabled`         | `true`  | Set to `false` to turn the plugin off without uninstalling it.                                  |
| `idleMinutes`     | `15`    | Minutes without input before a nap. Fractions are allowed, for example `0.25`.                  |
| `napOnBlur`       | `false` | Nap about 2 seconds after the terminal loses focus.                                             |
| `blurIdleMinutes` | unset   | Minutes without input before a nap while the terminal is unfocused. Set it below `idleMinutes`. |
| `carryDraft`      | `true`  | Carry unsent prompt text across a nap.                                                          |
| `debugLogFile`    | unset   | Absolute path of a diagnostic log file. The log never contains draft text.                      |

Input is a key press, a paste or mouse input. Switching focus is not input, and it never wakes a napping window.

An unknown or invalid option turns the plugin off. It writes one line to `debugLogFile`, if that is set, and shows nothing on screen.

The focus options need a terminal that reports focus. OpenCode turns focus reporting on only when the terminal answers its focus-mode query. Without focus reports, only `idleMinutes` applies.

## How wake works

When a window reaches its idle time, the OpenCode TUI process replaces itself in place with a small shell script. The process keeps its process ID. The script clears the screen and shows the session title and `Napping to save memory. Press any key or click to wake.`

A key press or a click wakes the window. It returns to the same session, or to the start screen if there was no session. The key or click is not passed to OpenCode. On Linux, a wake takes about 1.5 seconds to reach an interactive prompt.

A permission or question prompt does not stop a nap. Prompts that were pending at nap time, or that arrived while the window napped, are shown again after wake, and you can answer them.

## What is kept and what resets

Kept: the session, prompt history, open tabs, the selected model and plugin storage. Unsent prompt text is carried with the cursor at the end. If a permission or question prompt is on screen, the text comes back once the prompt box reappears.

Reset: the view, such as scroll position. The selected agent and model variant go back to their defaults, as they do on a normal restart.

Only plain text is carried. Attachments and images in the prompt are not. A `--prompt` or `--continue` you started with is not passed to the woken window.

If the OpenCode binary is no longer executable when you wake the window, for example after an upgrade, the script prints `Cannot wake` and the command that resumes the session, then exits.

## Platforms

- **Linux:** supported.
- **macOS:** supported. Terminals checked by hand: none yet. See [the macOS checklist](docs/macos-checklist.md).
- **Windows:** not supported. The plugin does nothing there.

The plugin works with the background service (the default) and with `--server <url>`.

The plugin turns itself off for the life of the window, and writes one log line, when:

- `enabled` is `false`, or an option is invalid.
- The platform is not Linux or macOS, or `process.execve` is not available.
- The code is not on the main thread.
- OpenCode runs with `--standalone`, its server runs inside the TUI process, or the server's process ID is unknown.
- Standard input or output is not a terminal.
- `/bin/sh` is not executable.
- `opencode` was started with a subcommand or an argument the plugin does not know. It knows `--server`, `--auto`, `--log-level`, `--print-logs`, `-s`/`--session`, `-c`/`--continue`, `--prompt` and one directory.
- An OpenCode internal the plugin relies on is missing. The plugin turns itself off rather than risk a broken nap.

It skips a nap and tries again about 5 seconds later when:

- OpenCode has handed the terminal to an external editor, or was stopped by job control.
- `carryDraft` is on and the draft cannot be read or saved. This happens when the focused editor is not OpenCode's prompt, or when OpenCode's internals have changed.
- The command that wakes the window cannot be built.

## Limits

- Focus rules need a terminal that reports focus.
- A napped window still uses about 4 MB.
- Only plain text drafts are carried.

## Development

```sh
bun install
npm run ci:check   # lint, typecheck, unit tests
npm run build
npm run test:e2e   # packs the package, installs it into a scratch HOME, drives real TUIs under a pseudo-terminal
```

The end-to-end suite uses a local fake model server. It calls no hosted models.

To release, commit `chore: release X.Y.Z` with the matching `package.json` version, then push a `vX.Y.Z` tag. The release workflow checks that the tag matches `package.json`, runs the checks, and publishes to npm with provenance.

## License

MIT. See [LICENSE](LICENSE).
