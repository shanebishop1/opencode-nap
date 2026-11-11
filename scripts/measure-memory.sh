#!/usr/bin/env bash
# Measures OpenCode TUI client memory: N empty windows awake, then the same N
# windows napped by opencode-nap. Runs in a private tmux server against a
# private loopback `opencode serve` with a throwaway HOME, so your own config,
# sessions and running service are never touched. No model is ever called.
# Linux only (reads /proc); needs opencode, tmux, git, bc and python3.
#
# Usage: measure-memory.sh [windows] [opencode-nap version] [sessions dir]
#   windows   number of TUI windows (default 10)
#   version   npm version or tag of opencode-nap (default latest)
#   sessions  a directory of `opencode session export` JSON files; each is
#             imported into the private server and opened in its own window.
#             Without it every window is an empty start screen.
#
# RSS counts every page a process maps, shared ones included, so a sum of RSS
# over-counts what the windows share. PSS splits shared pages between the
# processes that map them, so the PSS sum is the memory the windows really cost.
set -euo pipefail

N=${1:-10}
NAP_VERSION=${2:-latest}
SESSIONS_DIR=${3:-}
IDLE_MINUTES=1.5          # long enough to measure every window awake first
SETTLE_SECONDS=30         # after the last window draws, before the awake sample
PORT=$((47000 + RANDOM % 1000))
SOCKET="nap-ram-$$"
OPENCODE=$(readlink -f "$(command -v opencode)")

S=$(mktemp -d "${TMPDIR:-/tmp}/nap-ram.XXXXXX")
cleanup() {
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCKET"
  rm -rf "$S"
}
trap cleanup EXIT INT TERM

H=$S/home
mkdir -p "$H/.config/opencode" "$S/project"
git -C "$S/project" init -q
cat >"$H/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "enabled_providers": [],
  "plugins": [{ "package": "opencode-nap@$NAP_VERSION", "options": { "idleMinutes": $IDLE_MINUTES } }]
}
EOF

ENV=(env -i "HOME=$H" "PATH=/usr/local/bin:/usr/bin:/bin" "TERM=xterm-256color" "LANG=C.UTF-8"
  "XDG_CONFIG_HOME=$H/.config" "XDG_DATA_HOME=$H/.local/share" "XDG_STATE_HOME=$H/.local/state"
  "XDG_CACHE_HOME=$H/.cache" "OPENCODE_DISABLE_AUTOUPDATE=1")
T() { tmux -L "$SOCKET" "$@"; }

# Every pid in the process tree under $1, $1 included.
tree() {
  local pid=$1
  echo "$pid"
  for child in $(pgrep -P "$pid" || true); do tree "$child"; done
}

# Sums RSS and PSS (KiB) over the process trees of the given pane pids.
sample() {
  local rss=0 pss=0 procs=0 pid kib
  for pane in "$@"; do
    for pid in $(tree "$pane"); do
      [ -r "/proc/$pid/smaps_rollup" ] || continue
      kib=$(awk '/^Rss:/ {print $2}' "/proc/$pid/smaps_rollup"); rss=$((rss + ${kib:-0}))
      kib=$(awk '/^Pss:/ {print $2}' "/proc/$pid/smaps_rollup"); pss=$((pss + ${kib:-0}))
      procs=$((procs + 1))
    done
  done
  echo "$rss $pss $procs"
}

count_panes() { # how many windows show the pattern
  local n=0
  for i in $(seq 1 "$N"); do
    T capture-pane -p -t "nap:w$i" 2>/dev/null | grep -q "$1" && n=$((n + 1))
  done
  echo "$n"
}

wait_for() { # pattern, timeout seconds, label
  local deadline=$((SECONDS + $2))
  until [ "$(count_panes "$1")" -eq "$N" ]; do
    if [ $SECONDS -ge $deadline ]; then
      echo "timed out waiting for $3 ($(count_panes "$1")/$N); first window shows:" >&2
      T capture-pane -p -t nap:w1 | grep -v '^\s*$' | tail -8 >&2
      exit 1
    fi
    sleep 2
  done
}

report() { # label rss pss procs
  printf '%-8s %3d windows %3d processes   PSS %7.1f MiB total %6.1f MiB/window   RSS %7.1f MiB total %6.1f MiB/window\n' \
    "$1" "$N" "$4" "$(echo "$3/1024" | bc -l)" "$(echo "$3/1024/$N" | bc -l)" "$(echo "$2/1024" | bc -l)" "$(echo "$2/1024/$N" | bc -l)"
}

echo "host $(hostname), opencode $("$OPENCODE" --version 2>/dev/null | head -1), opencode-nap@$NAP_VERSION, $N windows"
T -f /dev/null new-session -d -s nap -n server -x 120 -y 36 \
  "${ENV[*]} $OPENCODE serve --hostname 127.0.0.1 --port $PORT >$S/server.log 2>&1"
for _ in $(seq 1 30); do grep -q '^server password ' "$S/server.log" 2>/dev/null && break; sleep 1; done
PASSWORD=$(sed -n 's/^server password //p' "$S/server.log")
[ -n "$PASSWORD" ] || { echo "the server did not start" >&2; cat "$S/server.log" >&2; exit 1; }

URL=http://127.0.0.1:$PORT
SESSION_ARGS=()
if [ -n "$SESSIONS_DIR" ]; then
  for file in "$SESSIONS_DIR"/*.json; do
    [ ${#SESSION_ARGS[@]} -lt "$N" ] || break
    "${ENV[@]}" OPENCODE_PASSWORD="$PASSWORD" "$OPENCODE" session import --server "$URL" --directory "$S/project" "$file" >/dev/null
    SESSION_ARGS+=("-s $(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["info"]["id"])' "$file")")
  done
  [ ${#SESSION_ARGS[@]} -eq "$N" ] || { echo "found ${#SESSION_ARGS[@]} sessions for $N windows" >&2; exit 1; }
  echo "imported $N sessions, $(du -ch "$SESSIONS_DIR"/*.json | tail -1 | cut -f1) of exported JSON"
fi
for i in $(seq 1 "$N"); do
  T new-window -d -t nap -n "w$i" -c "$S/project" \
    "exec ${ENV[*]} OPENCODE_PASSWORD=$PASSWORD $OPENCODE --server $URL ${SESSION_ARGS[$((i - 1))]:-}"
done
PANES=()
for i in $(seq 1 "$N"); do PANES+=("$(T list-panes -t "nap:w$i" -F '#{pane_pid}')"); done

wait_for "ctrl+p commands" 120 "every window to draw"
sleep "$SETTLE_SECONDS"
if [ "$(count_panes 'Press any key or click to wake')" -ne 0 ]; then
  echo "a window napped before the awake sample; raise IDLE_MINUTES" >&2; exit 1
fi
SERVER_PID=$(T list-panes -t nap:server -F '#{pane_pid}')
server() { # label
  read -r rss pss _ < <(sample "$SERVER_PID")
  printf '%-8s server       PSS %7.1f MiB, RSS %7.1f MiB (not counted above)\n' "$1" "$(echo "$pss/1024" | bc -l)" "$(echo "$rss/1024" | bc -l)"
}
read -r rss pss procs < <(sample "${PANES[@]}")
report awake "$rss" "$pss" "$procs"
server awake

wait_for "Press any key or click to wake" 240 "every window to nap"
sleep 5
read -r rss pss procs < <(sample "${PANES[@]}")
report napped "$rss" "$pss" "$procs"
server napped
