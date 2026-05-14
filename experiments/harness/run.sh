#!/usr/bin/env bash
# Run an experiment on a USB-connected Android phone end-to-end:
#
#   1. adb reverse so the phone reaches the desktop vite dev server.
#   2. Grant Chrome the OS-level CAMERA + RECORD_AUDIO permissions
#      (the Android app permission; the per-site grant is separate and
#      must be tapped once on the device — see experiments/README.md).
#   3. adb forward Chrome's DevTools socket to localhost:9222.
#   4. Hand off to run-cdp.mjs, which navigates to the experiment and
#      writes experiments/<name>/result.json.
#
# Usage:
#   experiments/harness/run.sh <experiment-name>          # PORT defaults to 5173
#   PORT=5174 experiments/harness/run.sh raw-capability
#
# The vite dev server (`pnpm dev`) must already be running.

set -euo pipefail

EXPERIMENT="${1:-}"
if [ -z "$EXPERIMENT" ]; then
  echo "usage: experiments/harness/run.sh <experiment-name>" >&2
  exit 2
fi
PORT="${PORT:-5173}"
CDP_PORT="${CDP_PORT:-9222}"
PKG="${PKG:-com.android.chrome}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH" >&2
  exit 1
fi
if [ -z "$(adb devices | awk 'NR>1 && $2=="device" {print; exit}')" ]; then
  echo "No authorised adb device. Plug the phone in and accept the USB-debugging prompt." >&2
  exit 1
fi

echo "[run] waking device + reverse :$PORT"
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
adb reverse --remove tcp:"$PORT" >/dev/null 2>&1 || true
adb reverse tcp:"$PORT" tcp:"$PORT" >/dev/null

echo "[run] granting Chrome OS camera + mic permissions"
adb shell pm grant "$PKG" android.permission.CAMERA >/dev/null 2>&1 || true
adb shell pm grant "$PKG" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true

# Chrome must be running for its DevTools socket to exist.
chrome_pid="$(adb shell pidof "$PKG" | tr -d '\r')"
if [ -z "$chrome_pid" ]; then
  echo "[run] launching Chrome"
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 2
  chrome_pid="$(adb shell pidof "$PKG" | tr -d '\r')"
fi

# Resolve CHROME's socket specifically. Other Chromium browsers (Brave,
# etc.) also expose a *_devtools_remote socket — Brave in particular
# squats the unsuffixed `chrome_devtools_remote`, so naively picking the
# first match drives the wrong browser. Chrome's socket is suffixed with
# its PID; prefer that, fall back to the bare name only if absent.
sockets="$(adb shell cat /proc/net/unix | awk '/@chrome_devtools_remote/ {print $NF}' | tr -d '\r' | sort -u)"
socket="$(echo "$sockets" | grep -E "^@chrome_devtools_remote_${chrome_pid}\$" | head -n1 | sed 's/^@//')"
if [ -z "$socket" ]; then
  socket="$(echo "$sockets" | grep -E '^@chrome_devtools_remote$' | head -n1 | sed 's/^@//')"
fi
if [ -z "$socket" ]; then
  echo "Chrome DevTools socket not found — is Chrome running on the device?" >&2
  exit 1
fi
echo "[run] forward :$CDP_PORT -> @$socket"
adb forward --remove tcp:"$CDP_PORT" >/dev/null 2>&1 || true
adb forward tcp:"$CDP_PORT" localabstract:"$socket" >/dev/null

echo "[run] handing off to run-cdp.mjs"
exec node "$(dirname "$0")/run-cdp.mjs" "$EXPERIMENT" "$PORT"
