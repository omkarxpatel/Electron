#!/bin/bash
# Spike harness: start the tap with the given flags, confirm the aggregate
# device publishes, then read from it via Electron/Chromium while generating
# known system audio. Prints peak amplitude so we can tell "device exists"
# apart from "device delivers samples".
#
#   ./run-test.sh                 # global tap, unmuted
#   ./run-test.sh --mute          # muted (Live-mode shape)
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE=/private/tmp/claude-501/-Users-omkar-Coding-Audio-Visualizer/6849ed1a-7ac3-40d3-90fb-700796959ef5/scratchpad/eprobe
APP="/Users/omkar/Coding/Audio Visualizer"

# TERM (not KILL) so the tap process runs its teardown; then sweep any
# aggregate a previous hard kill left registered with coreaudiod.
pkill -TERM -f tapspike 2>/dev/null
sleep 0.5
"$HERE/tapspike" --cleanup >/dev/null 2>&1

echo "--- starting: tapspike $* ---"
"$HERE/tapspike" "$@" > /tmp/tapspike-run.log 2>&1 &
TAP_PID=$!
trap 'kill -TERM $TAP_PID 2>/dev/null' EXIT

for _ in $(seq 1 15); do
  "$HERE/tapspike" --list 2>/dev/null | grep -q "AV Tap Spike" && break
  sleep 0.4
done

# Generate audio the tap should see, in parallel with the capture window.
# Sustained full-scale tone: a deterministic source, unlike `say`.
( afplay /tmp/tone.wav ) &
SAY_PID=$!

cd "$APP"
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron "$PROBE/capture.js" 2>&1 \
  | grep -A20 "CAPTURE_RESULT"

kill -9 $SAY_PID 2>/dev/null
kill -TERM $TAP_PID 2>/dev/null
sleep 0.5
echo "--- tap process log ---"
head -8 /tmp/tapspike-run.log
