import { replaceControls } from "./text.js"

export interface StubInput {
  /** The nap screen, printed verbatim; see card.ts. */
  card: string
  terminalTitle?: string
  /** Whether regaining focus wakes it, for a nap taken while unfocused. */
  wakeOnFocus: boolean
  opencodePath: string
  /**
   * The background service to wake into with --server: its registration file
   * and the version of the service this window napped from. Unset when the
   * window names its server itself.
   */
  service?: { file: string; version: string }
  args: string[]
}

export interface StubExec {
  file: "/bin/sh"
  argv: string[]
}

// The stub is POSIX sh in two stages, run as
// `sh -c STUB_SCRIPT sh <title and card> <wake> <opencode> <service file> <service version> <args...>`. Values only ever arrive
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
//
// A plain `opencode` first checks the background service, and replaces it
// when it does not answer in time, which ends every window's shells. Windows
// that wake together keep a busy service busy, so a wake that finds the
// service registered and running connects to it with --server instead, which
// never replaces it. `field` reads the registration, written by
// JSON.stringify on one line, with shell patterns: no parser is needed, and a
// value with an escape in it is refused rather than guessed at. The version
// must be the one the window napped from, so a registration left by another
// channel or release is not taken for this window's service.
//
// While the service is busy, curl waits for it, so the TUI's own short check
// succeeds; its password reaches curl on stdin (`-q` keeps ~/.curlrc out of
// it) and OpenCode in the environment, never in an argument. The wait has no
// limit, because giving up would be the restart this avoids; Ctrl-C ends it
// and starts the usual way. A registration that is missing, stale, for
// another version, or a service that refuses, has failed or is not
// listening, falls back to the plain start, which starts or repairs the
// service as before.
const WAIT_SCRIPT = `
wake=$1 opencode=$2 service=$3 version=$4
shift 4
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
field() {
  quoted=
  case $json in *"\\"$1\\":"*) ;; *) return 1 ;; esac
  value=\${json#*"\\"$1\\":"}
  case $value in
    \\"*) quoted=1; value=\${value#\\"}; value=\${value%%\\"*} ;;
    *) value=\${value%%[!0-9]*} ;;
  esac
  case $value in '' | *\\\\*) return 1 ;; esac
}
# One request: 0 when the service answers, 2 while it is busy or starting,
# 1 when it refuses, has failed or is not there.
ask() {
  code=$(printf 'user = "opencode:%s"\\n' "$password" | curl -q -s --noproxy '*' -o /dev/null -w '%{http_code}' -m 4 -K - "$url/api/info")
  case $? in
    0) ;;
    28 | 52 | 56) return 2 ;;
    *) return 1 ;;
  esac
  case $code in
    2??) return 0 ;;
    500) return 1 ;;
    5??) return 2 ;;
    *) return 1 ;;
  esac
}
attach() {
  [ -n "$service" ] && [ -n "$version" ] && [ -r "$service" ] || return 1
  json=
  while IFS= read -r line || [ -n "$line" ]; do json=$json$line; done < "$service" || return 1
  field version && [ "$value" = "$version" ] || return 1
  field pid && [ -z "$quoted" ] || return 1
  pid=$value
  # kill -0 0 would test the stub's own process group.
  case $pid in 0 | 1) return 1 ;; esac
  field url || return 1
  url=$value
  case $url in http://* | https://*) ;; *) return 1 ;; esac
  field password || return 1
  password=$value
  kill -0 "$pid" 2>/dev/null || return 1
  if command -v curl >/dev/null 2>&1; then
    stop= waiting=
    trap 'stop=1' INT
    while :; do
      ask
      case $? in
        0) break ;;
        1) trap - INT; return 1 ;;
      esac
      if [ -n "$stop" ] || ! kill -0 "$pid" 2>/dev/null; then trap - INT; return 1; fi
      [ -n "$waiting" ] || printf 'Waiting for the OpenCode service at %s to answer.\\nCtrl-C stops waiting and starts OpenCode the usual way, which restarts a service that does not answer.\\n' "$url"
      waiting=1
    done
    trap - INT
  fi
  OPENCODE_PASSWORD=$password OPENCODE_NAP_SERVER=$url
  export OPENCODE_PASSWORD OPENCODE_NAP_SERVER
  exec "$opencode" --server "$url" "$@"
}
if [ -f "$opencode" ] && [ -x "$opencode" ]; then
  attach "$@"
  exec "$opencode" "$@"
fi
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
wake=$2 opencode=$3 service=$4 version=$5
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
# Report the title from the new process, after leaving the alternate screen.
printf '%s' "$1"
shift 5
exec /bin/sh -c ${singleQuoted(WAIT_SCRIPT)} sh "$wake" "$opencode" "$service" "$version" "$@"
`

export function buildStubExec(input: StubInput): StubExec {
  const title = replaceControls(input.terminalTitle ?? "")
  // Match OpenTUI's 4096-byte control packet, including the OSC framing.
  const titleSequence = title && Buffer.byteLength(title) <= 4091 ? `\x1b]0;${title}\x07` : ""
  return {
    file: "/bin/sh",
    argv: [
      "sh",
      "-c",
      STUB_SCRIPT,
      "sh",
      titleSequence + input.card,
      input.wakeOnFocus ? "focus" : "keys",
      input.opencodePath,
      input.service?.file ?? "",
      input.service?.version ?? "",
      ...input.args,
    ],
  }
}
