# opencode-nap

[![npm](https://img.shields.io/npm/v/opencode-nap?logo=npm&style=flat-square)](https://www.npmjs.com/package/opencode-nap)
[![License](https://img.shields.io/npm/l/opencode-nap?style=flat-square)](./LICENSE)

An OpenCode 2 plugin that puts idle terminal windows to sleep to free memory, and wakes them into the same session when you press a key or click.

Each open OpenCode window holds around 150 MB, even when you are not using it. A napping window holds about 4 MB. Work keeps running while a window naps, because sessions live in the OpenCode server, not in the window.

It works in any terminal, inside or outside tmux, with nothing else to install.

**This plugin was not built by the OpenCode team and is not affiliated with them.**

## Install

Add it to your global `~/.config/opencode/opencode.json` or a project's `opencode.json`:

```json
{
  "plugins": ["opencode-nap"]
}
```

Restart your OpenCode windows. Each one naps after 15 minutes without input.

## Options

Use the object form in the same file to set options:

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

| Option            | Default | Meaning                                                                          |
| ----------------- | ------- | -------------------------------------------------------------------------------- |
| `idleMinutes`     | `15`    | Minutes without input before a window naps. Fractions are allowed.               |
| `napOnBlur`       | `false` | Nap a couple of seconds after the terminal loses focus.                          |
| `blurIdleMinutes` | unset   | A shorter idle time that applies while the terminal is unfocused.                |
| `carryDraft`      | `true`  | Bring back unsent prompt text after a nap.                                       |
| `enabled`         | `true`  | Set to `false` to turn the plugin off without removing it.                       |
| `debugLogFile`    | unset   | Absolute path of a diagnostic log. It never contains prompt text.                |

Input means a key press, a paste or mouse input. The focus options need a terminal that reports focus changes; without them, only `idleMinutes` applies. An unknown or invalid option turns the plugin off.

## How it works

When a window has been idle long enough, the OpenCode process replaces itself with a tiny shell script that waits. It first draws a copy of OpenCode's home screen in your theme's colours: the logo, a box saying the window is napping with the session title, and the working directory. The screen is drawn once, so it stays as it was if you resize the terminal or change the theme while the window naps; a terminal too small for it gets a line of plain text. Press any key or click to wake it: OpenCode starts again in the same window and opens the same session. The key you pressed is not sent to OpenCode.

Waking takes a second or two. A running session carries on in the server the whole time, and a permission or question prompt that comes up while the window naps is waiting for you when it wakes.

After a wake you get the same session, prompt history, open tabs, selected model and any unsent prompt text. The view starts fresh, as it does after a normal restart: scroll position resets, and the agent and model variant go back to their defaults. Attachments and images in an unsent prompt are not kept.

## When it does not nap

The plugin turns itself off for a window when napping could lose work or is not possible:

- OpenCode runs with `--standalone`, so the session lives inside the window.
- OpenCode was started with a subcommand or an option the plugin does not recognise.
- The platform is not macOS or Linux, or the terminal is not a real terminal.
- An OpenCode internal the plugin relies on has changed.

It waits and tries again a few seconds later while an external editor has the terminal, or while unsent prompt text cannot be saved.

## Platforms

macOS and Linux. On Windows the plugin does nothing.

## Development

```sh
bun install
npm run ci:check   # lint, typecheck, unit tests
npm run build
npm run test:e2e   # drives real OpenCode windows against a local fake model
```

The end-to-end tests never call a hosted model. [docs/macos-checklist.md](docs/macos-checklist.md) covers checking a real terminal by hand.

## License

MIT. See [LICENSE](LICENSE).
