#!/usr/bin/env bash
# Repeatable live-UI capture: launch Electron with CDP on a hermetic HOME,
# run a JS interaction script, screenshot the page, then stop the app.
# Usage: bash scripts/capture-ui.sh <name> <interaction-js-file> [home-dir]
set -euo pipefail

NAME="${1:?usage: capture-ui.sh <name> <interaction-js-file> [home-dir]}"
SCRIPT_FILE="${2:?interaction JS file required}"
HOME_DIR="${3:-/tmp/opensand-ui-capture-home}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_PORT="${OPENSAND_CDP_PORT:-9222}"
SHOT_DIR="$ROOT/.workmate-shots"

mkdir -p "$HOME_DIR/.opensand" "$SHOT_DIR"
cd "$ROOT"
HOME="$HOME_DIR" pnpm --filter @opensand/desktop exec electron . --remote-debugging-port="$CDP_PORT" > "/tmp/opensand-capture-$NAME.log" 2>&1 &
APP_PID=$!
cleanup() { kill "$APP_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -sf --max-time 1 "http://127.0.0.1:$CDP_PORT/json/list" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
# Give the renderer time to boot and hydrate its lists before interaction.
sleep 2

HOME_DIR="$HOME_DIR" CDP_PORT="$CDP_PORT" SCRIPT_FILE="$SCRIPT_FILE" OUTPUT="$SHOT_DIR/$NAME.png" python3 - <<'PY'
import base64, json, os, time, urllib.request, websocket

port = os.environ["CDP_PORT"]
targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
page = next(t for t in targets if t.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20)
script = open(os.environ["SCRIPT_FILE"]).read()
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": script, "awaitPromise": True, "returnByValue": True}}))
# Wait for the interaction result, then let the compositor paint before capture.
while True:
    message = json.loads(ws.recv())
    if message.get("id") == 1:
        info = message.get("result", {}).get("result", {}).get("value")
        break
time.sleep(0.5)
ws.send(json.dumps({"id": 2, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
shot = None
for _ in range(40):
    message = json.loads(ws.recv())
    if message.get("id") == 2:
        shot = base64.b64decode(message["result"]["data"])
    if info is not None and shot:
        break
ws.close()
if not shot:
    raise SystemExit("screenshot failed")
open(os.environ["OUTPUT"], "wb").write(shot)
print(json.dumps({"info": info, "bytes": len(shot), "path": os.environ["OUTPUT"]}, ensure_ascii=False))
PY
