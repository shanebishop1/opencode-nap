# opencode-nap

An OpenCode 2 TUI plugin that naps idle windows to save memory, then wakes them into the same session on a key press or click.

A napping window drops from about 150 MB to about 4 MB. Runs keep going in the OpenCode server while a window naps, including runs that are still streaming. Unsent prompt text comes back after wake.

## Install

OpenCode 2 TUI plugins are listed in `cli.json`, not `opencode.json`. The file is `$XDG_CONFIG_HOME/opencode/cli.json`, usually `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-nap"]
}
```

`opencode plugin add opencode-nap` adds the same entry.

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

## Options

| Option            | Default | Meaning                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------- |
| `enabled`         | `true`  | Set to `false` to turn the plugin off without uninstalling it.                           |
| `idleMinutes`     | `15`    | Minutes without input before a nap. Fractions are allowed, for example `0.25`.           |
| `napOnBlur`       | `false` | Nap about 2 seconds after the terminal loses focus.                                      |
| `blurIdleMinutes` | unset   | Idle minutes before a nap while the terminal is unfocused. Shorter than `idleMinutes`.   |
| `carryDraft`      | `true`  | Carry unsent prompt text across a nap.                                                   |
| `debugLogFile`    | unset   | Absolute path of a diagnostic log file. The log never contains draft text.               |

Invalid or unknown options turn the plugin off and write one log line.

The focus options need a terminal that reports focus. OpenCode turns focus reporting on when the terminal supports it. Without focus reports, only `idleMinutes` applies. Switching focus never counts as input, and it never wakes a napping window.

## How wake works

When a window reaches its idle time, the OpenCode TUI process replaces itself in place with a small shell script. The script shows a card with the session title and how to wake the window. The process keeps its process ID.

A key press or a click wakes the window. It returns to the same session, or to the start screen if there was no session. The key or click is not passed to OpenCode. A typical wake takes about 1.5 seconds to reach an interactive prompt.

Permission and question prompts that were pending at nap time are shown again after wake, and you can answer them.

## What is kept and what resets

Kept: session history, tabs, the model, and plugin storage. Unsent prompt text is carried with the cursor at the end.

Reset: the view, such as scroll position. The selected agent and model variant go back to their defaults, as they do on a normal restart.

Only plain text is carried. Attachments and images in the prompt are not. A `--prompt` you started with is never sent again.

If OpenCode is upgraded or removed while a window naps, the card prints the command to resume the session.

## Platforms

- **Linux:** supported.
- **macOS:** supported. Terminals checked by hand: none yet. See [the macOS checklist](docs/macos-checklist.md).
- **Windows:** not supported. The plugin does nothing there.

The plugin works with the background service (the default) and with `--server <url>`.

The plugin does not nap, and writes one log line, when:

- OpenCode runs with `--standalone`, or its server runs inside the TUI process.
- The platform is Windows, or `process.execve` is not available.
- The code is not on the main thread.
- Standard input or output is not a terminal.
- `/bin/sh` is not executable.
- `opencode` receives unknown arguments or subcommands.
- An OpenCode internal the plugin relies on is missing. The plugin turns itself off rather than risk a broken nap.

It waits and retries later when OpenCode has handed the terminal to an external editor or is suspended, or when the draft cannot be read because OpenCode changed.

## Limits

- Idle time is checked every few seconds, so a nap can start up to about 10 seconds late.
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
