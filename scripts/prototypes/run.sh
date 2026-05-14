#!/usr/bin/env bash
# Run a prototype page on a USB-connected Android phone end-to-end:
#
#   1. adb reverse so the phone reaches the desktop vite dev server.
#   2. Grant Chrome the OS-level CAMERA + RECORD_AUDIO permissions —
#      CDP's Browser.grantPermissions handles the *site* permission but
#      NOT the Android app permission; without this getUserMedia throws
#      NotAllowedError.
#   3. adb forward the Chrome DevTools socket to localhost:9222.
#   4. Hand off to run-cdp.mjs, which grants the site permission,
#      navigates to the prototype page, and prints its [prototype-result].
#
# Usage:
#   scripts/prototypes/run.sh <prototype-name>          # PORT defaults to 5173
#   PORT=5174 scripts/prototypes/run.sh raw-capability
#
# The vite dev server (`pnpm dev`) must already be running.

set -euo pipefail

PROTOTYPE="${1:-}"
if [ -z "$PROTOTYPE" ]; then
  echo "usage: scripts/prototypes/run.sh <prototype-name>" >&2
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
if [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
  echo "[run] launching Chrome"
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 2
fi

socket="$(adb shell cat /proc/net/unix | grep -o 'chrome_devtools_remote[^ ]*' | head -1 | tr -d '\r')"
if [ -z "$socket" ]; then
  echo "Chrome DevTools socket not found — is Chrome running on the device?" >&2
  exit 1
fi
echo "[run] forward :$CDP_PORT -> @$socket"
adb forward --remove tcp:"$CDP_PORT" >/dev/null 2>&1 || true
adb forward tcp:"$CDP_PORT" localabstract:"$socket" >/dev/null

echo "[run] handing off to run-cdp.mjs"
exec node "$(dirname "$0")/run-cdp.mjs" "$PROTOTYPE" "$PORT"
