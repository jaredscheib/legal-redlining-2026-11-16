#!/usr/bin/env bash
# scripts/dev.sh start|stop
# start: API on $API_PORT (8787) and Vite on $WEB_PORT (5173) in the background.
#        pids in data/*.pid, logs in data/*.log.
# stop:  stops whatever the pid files name.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
mkdir -p data

wait_for() { # url, pid, log
  for _ in $(seq 1 100); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$2" 2>/dev/null; then
      echo "dev: process exited early; see $3" >&2
      tail -n 20 "$3" >&2
      return 1
    fi
    node -e 'setTimeout(()=>{},100)'
  done
  echo "dev: timed out waiting for $1" >&2
  return 1
}

running() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

start() {
  if running data/api.pid || running data/web.pid; then
    echo "dev: already running (make dev-stop first)" >&2
    exit 1
  fi

  PORT="$API_PORT" nohup ./scripts/with-keychain ANTHROPIC_API_KEY -- \
    node --import tsx api/src/server.ts >data/api.log 2>&1 &
  echo $! >data/api.pid

  (cd web && VITE_VERSION="${GIT_SHA:-dev}" API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" \
    exec nohup ../node_modules/.bin/vite --port "$WEB_PORT" --strictPort) >data/web.log 2>&1 &
  echo $! >data/web.pid

  wait_for "http://127.0.0.1:$API_PORT/healthz" "$(cat data/api.pid)" data/api.log
  wait_for "http://localhost:$WEB_PORT/" "$(cat data/web.pid)" data/web.log
  echo "dev: api http://127.0.0.1:$API_PORT (pid $(cat data/api.pid), log data/api.log)"
  echo "dev: web http://localhost:$WEB_PORT (pid $(cat data/web.pid), log data/web.log)"
}

stop() {
  for name in web api; do
    f="data/$name.pid"
    if running "$f"; then
      kill "$(cat "$f")" && echo "dev: stopped $name (pid $(cat "$f"))"
    fi
    rm -f "$f"
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
