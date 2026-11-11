export interface StubInput {
  /** The nap screen, printed verbatim; see card.ts. */
  card: string
  /** Whether regaining focus wakes it, for a nap that losing focus started. */
  wakeOnFocus: boolean
  opencodePath: string
  args: string[]
}

export interface StubExec {
  file: "/bin/sh"
  argv: string[]
}

// The stub is POSIX sh in two stages, run as
// `sh -c STUB_SCRIPT sh <card> <wake> <opencode> <args...>`. Values only ever arrive
// as positional parameters. In these template literals every backslash is
// doubled and every `${` is escaped.
//
// Stage one resets the terminal and prints the card, then replaces itself with
// stage two, which waits for a key. Printing expands the card in the shell's
// memory, and a shell that kept that copy would hold it for as long as the
// window naps; a new process image holds nothing but its own arguments.
//
// The first byte is read by `dd`: dash has no single-byte `read`, and bash's
// `read -n 1` switches the terminal back to signal mode, so Ctrl-C would kill
// the stub instead of waking it. The rest of an escape or mouse sequence is
// drained by the `read` builtin until 0.1 s passes with no input.
//
// With <wake> set to `focus`, the terminal also reports focus. Focus in wakes
// the window like a key; focus out (`ESC [ O`, whose first byte `dd` took)
// goes back to waiting.
const WAIT_SCRIPT = `
wake=$1 opencode=$2
shift 2
if [ "$wake" = focus ]; then printf '\\033[?1004h'; fi
printf '\\033[?1000h\\033[?1006h'
while :; do
  stty min 1 time 0 2>/dev/null
  dd bs=1 count=1 of=/dev/null 2>/dev/null
  stty min 0 time 1 2>/dev/null
  rest=
  while IFS= read -r drained; do rest=$rest$drained; done
  [ "$rest$drained" = "[O" ] || break
done
# Clicks off before draining, so a late button release is never reported.
printf '\\033[?1000l\\033[?1006l\\033[?1004l'
stty min 0 time 1 2>/dev/null
while IFS= read -r drained; do :; done
# The card's colours and hidden cursor must not outlive it.
printf '\\033[0m\\033[?25h\\033[2J\\033[H'
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

const singleQuoted = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`

export const STUB_SCRIPT = `
wake=$2 opencode=$3
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
printf '%s' "$1"
shift 3
exec /bin/sh -c ${singleQuoted(WAIT_SCRIPT)} sh "$wake" "$opencode" "$@"
`

export function buildStubExec(input: StubInput): StubExec {
  return {
    file: "/bin/sh",
    argv: [
      "sh",
      "-c",
      STUB_SCRIPT,
      "sh",
      input.card,
      input.wakeOnFocus ? "focus" : "keys",
      input.opencodePath,
      ...input.args,
    ],
  }
}
