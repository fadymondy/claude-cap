#!/usr/bin/env bash
# Launch Chrome with CDP enabled (if not already), then start cap-cdp-mcp in HTTP mode.
set -e

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORT="${PORT:-3838}"
CDP_PORT="${CDP_PORT:-9222}"

if ! curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome debug port not responding on ${CDP_PORT}. Launching Chrome..."
  killall "Google Chrome" 2>/dev/null || true
  sleep 1
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="${HOME}/Library/Application Support/Google/Chrome" \
    &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
      echo "Chrome ready."
      break
    fi
  done
else
  echo "Chrome already exposes CDP on port ${CDP_PORT}."
fi

echo "Starting cap-cdp-mcp on :${PORT}..."
exec node "${HERE}/src/index.js" --http ":${PORT}"
