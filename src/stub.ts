export interface StubInput {
  cardTitle: string | undefined
  opencodePath: string
  args: string[]
}

export interface StubExec {
  file: "/bin/sh"
  argv: string[]
}

// POSIX sh, run as `sh -c STUB_SCRIPT sh <title> <opencode> <args...>`. Values
// only ever arrive as positional parameters. In this template literal every
// backslash is doubled and every `${` is escaped.
//
// The first byte is read by `dd`: dash has no single-byte `read`, and bash's
// `read -n 1` switches the terminal back to signal mode, so Ctrl-C would kill
// the stub instead of waking it. The rest of an escape or mouse sequence is
// drained by the `read` builtin until 0.1 s passes with no input.
export const STUB_SCRIPT = `
title=$1 opencode=$2
shift 2
stty sane 2>/dev/null
# Synchronized output off first so the rest shows. Kitty keyboard stacks are
# per screen: pop all on the alternate screen, leave it, pop all on the main one.
printf '\\033[?2026l\\033[<99u\\033[?1049l\\033[<99u'
printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l'
printf '\\033[?1004l\\033[?2004l\\033[?2027l\\033[?2031l'
printf '\\033[?25h\\033[0m\\033[2J\\033[H'
# Discard input queued before those modes went off (a late focus or theme
# report), so only input that comes after the card wakes the stub.
stty raw -echo min 0 time 1 2>/dev/null
while IFS= read -r drained; do :; done
if [ -n "$title" ]; then printf '%s\\r\\n' "$title"; fi
printf 'Napping to save memory. Press any key or click to wake.\\r\\n'
stty min 1 time 0 2>/dev/null
printf '\\033[?1000h\\033[?1006h'
dd bs=1 count=1 of=/dev/null 2>/dev/null
# Clicks off before draining, so a late button release is never reported.
printf '\\033[?1000l\\033[?1006l'
stty min 0 time 1 2>/dev/null
while IFS= read -r drained; do :; done
stty sane 2>/dev/null
if [ -f "$opencode" ] && [ -x "$opencode" ]; then exec "$opencode" "$@"; fi
quote() {
  case $1 in
    '' | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-]*) ;;
    *) cmd=$cmd$1; return ;;
  esac
  rest=$1
  cmd=$cmd\\'
  while :; do
    case $rest in
      *\\'*) cmd=$cmd\${rest%%\\'*}\\'\\\\\\'\\'; rest=\${rest#*\\'} ;;
      *) break ;;
    esac
  done
  cmd=$cmd$rest\\'
}
cmd=
quote "$opencode"
for arg in "$@"; do cmd="$cmd "; quote "$arg"; done
printf 'Cannot wake: %s is not executable.\\nTo resume, run:\\n  %s\\n' "$opencode" "$cmd" >&2
exit 1
`

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

// Turns C0, DEL and C1 characters (including ESC) into spaces, then collapses
// runs of spaces, so a title can never send a terminal sequence.
export function sanitizeTitle(title: string | undefined): string {
  return Array.from(title ?? "", char => isControl(char.codePointAt(0) ?? 0) ? " " : char)
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
}

export function buildStubExec(input: StubInput): StubExec {
  return {
    file: "/bin/sh",
    argv: [
      "sh",
      "-c",
      STUB_SCRIPT,
      "sh",
      sanitizeTitle(input.cardTitle),
      input.opencodePath,
      ...input.args,
    ],
  }
}
