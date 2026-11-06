#!/bin/zsh
# OpenSand desktop supervisor: builds if needed, starts desktop-server, restarts on dist changes.
# Usage:
#   scripts/opensand-desktop.sh           # foreground supervisor (for terminal/launchd)
#   scripts/opensand-desktop.sh --restart # restart the running server (builds first)
#   scripts/opensand-desktop.sh --stop    # stop it
#   scripts/opensand-desktop.sh --status  # show pid/log tail
# Renderer-only edits (packages/desktop/renderer/*) never need a server restart:
# the server reads them from disk on every request. Only TypeScript changes
# (packages/*/src) need: build -> the supervisor notices and restarts automatically.
ROOT="${0:A:h:h}"
DESKTOP="$ROOT/packages/desktop"
DEFAULT_LOG="/tmp/opensand-desktop.log"
DEFAULT_PIDFILE="/tmp/opensand-desktop.pid"
LOG="/tmp/opensand-desktop.log"
PIDFILE="/tmp/opensand-desktop.pid"

server_pid() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      print -r -- "$pid"
      return 0
    fi
  fi
  return 1
}

start_server() {
  local pid
  if pid="$(server_pid)"; then
    print -r -- "opensand-desktop: already running (pid $pid)"
    return 0
  fi
  (cd "$DESKTOP" && nohup node dist/src/desktop-server.js >>"$LOG" 2>&1 & print -r -- $! > "$PIDFILE")
  sleep 1
  print -r -- "opensand-desktop: started (pid $(cat "$PIDFILE"), log $LOG)"
}

stop_server() {
  local pid
  if pid="$(server_pid)"; then
    kill "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null
    rm -f "$PIDFILE"
    print -r -- "opensand-desktop: stopped (pid $pid)"
  else
    print -r -- "opensand-desktop: not running"
  fi
}

needs_build() {
    [[ -f "$marker" ]] || return 0
  find "$ROOT/packages/desktop/src" "$ROOT/packages/coordinator/src" "$ROOT/packages/native-bridge/src" "$ROOT/packages/local-exec-daemon/src" -name '*.ts' -type f -newer "$marker" -print -quit 2>/dev/null | grep -q .
}

build_if_needed() {
  if needs_build; then
    print -r -- "opensand-desktop: building..."
    (cd "$ROOT" && pnpm -r build >>"$LOG" 2>&1) || { print -r -- "opensand-desktop: build failed, see $LOG"; return 1; }
    return 0
  fi
  return 0
}

case "${1:-}" in
  --stop)
    stop_server
    ;;
  --status)
    if pid="$(server_pid)"; then print -r -- "running (pid $pid)"; else print -r -- "not running"; fi
    print -r -- "log: $LOG"
    tail -n 20 "$LOG" 2>/dev/null
    ;;
  --restart)
    build_if_needed || exit 1
    stop_server
    start_server
    ;;
  *)
    build_if_needed || exit 1
    start_server
    if [[ "${OPENSAND_NO_WATCH:-}" == "1" ]]; then exit 0; fi
    print -r -- "opensand-desktop: watching src for changes (Ctrl-C stops watcher, server keeps running)"
    while true; do
      if needs_build; then
        print -r -- "opensand-desktop: src changed, rebuilding + restarting..."
        if build_if_needed; then stop_server; start_server; fi
      fi
      sleep 2
    done
    ;;
esac
