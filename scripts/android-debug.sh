#!/usr/bin/env bash
# Wire up an Android Chrome tab for remote debugging from this machine.
#
#   1. `adb reverse` so the phone reaches the desktop vite dev server at
#      http://localhost:<DEV_PORT>.
#   2. `adb forward` the phone's Chrome DevTools Protocol abstract socket
#      to http://localhost:<CDP_PORT>. The socket name is suffixed with
#      Chrome's PID, so we look it up dynamically.
#   3. Print the open tabs (id, url, webSocketDebuggerUrl) so the next
#      tool (e.g. scripts/cdp-tail.ts) can attach.
#
# Usage:
#   scripts/android-debug.sh              # defaults: DEV_PORT=5173 CDP_PORT=9222
#   DEV_PORT=5174 scripts/android-debug.sh

set -euo pipefail

DEV_PORT="${DEV_PORT:-5173}"
CDP_PORT="${CDP_PORT:-9222}"
PKG="${PKG:-com.android.chrome}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH" >&2
  exit 1
fi

device_line="$(adb devices | awk 'NR>1 && $2=="device" {print; exit}')"
if [ -z "$device_line" ]; then
  echo "No authorised adb device. Plug the phone in and accept the USB-debugging prompt." >&2
  exit 1
fi
echo "device: $device_line"

chrome_pid="$(adb shell pidof "$PKG" | tr -d '\r')"
if [ -z "$chrome_pid" ]; then
  echo "Chrome ($PKG) is not running on the device. Open it and retry." >&2
  exit 1
fi
# Socket name varies: usually 'chrome_devtools_remote_<pid>', occasionally
# the unsuffixed 'chrome_devtools_remote'. Pick whichever is currently open.
sockets="$(adb shell cat /proc/net/unix | awk '/@chrome_devtools_remote/ {print $NF}' | tr -d '\r' | sort -u)"
socket="$(echo "$sockets" | grep -E "^@chrome_devtools_remote_${chrome_pid}\$" | head -n1 | sed 's/^@//')"
if [ -z "$socket" ]; then
  socket="$(echo "$sockets" | grep -E '^@chrome_devtools_remote$' | head -n1 | sed 's/^@//')"
fi
if [ -z "$socket" ]; then
  echo "No chrome_devtools_remote socket found. Is USB debugging enabled and Chrome in foreground?" >&2
  exit 1
fi
echo "chrome pid: $chrome_pid  socket: @$socket"

adb reverse --remove tcp:"$DEV_PORT" >/dev/null 2>&1 || true
adb reverse tcp:"$DEV_PORT" tcp:"$DEV_PORT" >/dev/null
echo "reverse: phone localhost:$DEV_PORT -> desktop :$DEV_PORT"

adb forward --remove tcp:"$CDP_PORT" >/dev/null 2>&1 || true
adb forward tcp:"$CDP_PORT" localabstract:"$socket" >/dev/null
echo "forward: desktop :$CDP_PORT -> phone @$socket"

echo
echo "--- browser ---"
curl -fsS "http://localhost:${CDP_PORT}/json/version" | sed 's/^/  /'
echo
echo "--- tabs ---"
curl -fsS "http://localhost:${CDP_PORT}/json" \
  | node -e '
    let s = "";
    process.stdin.on("data", c => s += c);
    process.stdin.on("end", () => {
      for (const t of JSON.parse(s)) {
        if (t.type !== "page") continue;
        console.log(`  ${t.id}  ${t.url}`);
        console.log(`         ${t.webSocketDebuggerUrl}`);
      }
    });
  '
