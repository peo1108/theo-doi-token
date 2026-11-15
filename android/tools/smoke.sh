#!/usr/bin/env bash
# Smoke test app Android trên emulator, với hub thật + remote.js thật + claude giả (ios/tools/smoke-server.js) chạy local.
# Chụp các màn hình chính vào android/build/smoke/ (xem bằng mắt rồi sửa lỗi giao diện).
#   android/tools/smoke.sh            # chạy hết
#   SMOKE_KEEP=1 android/tools/smoke.sh   # không tắt emulator / server khi xong
# Cần: JDK 21, Android SDK (emulator + system-images;android-36.1;google_apis;x86_64), Node, `npm ci` trong hub/.
set -uo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash không được đổi /sdcard/... thành đường dẫn Windows

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$ANDROID/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$(cygpath -u "$LOCALAPPDATA")/Android/Sdk}}"
ADB="$SDK/platform-tools/adb.exe"; [ -x "$ADB" ] || ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator.exe"; [ -x "$EMU" ] || EMU="$SDK/emulator/emulator"
AVDMGR="$SDK/cmdline-tools/latest/bin/avdmanager.bat"; [ -f "$AVDMGR" ] || AVDMGR="$SDK/cmdline-tools/latest/bin/avdmanager"
AVD="${SMOKE_AVD:-ccremote-smoke}"
PKG=vn.peo.ccremote
OUT="$ANDROID/build/smoke"
TMP="$ANDROID/build/smoke-tmp/run-$(date +%s)"   # thư mục mới mỗi lần (emulator có thể còn giữ file của lần trước)
PORT="${SMOKE_HUB_PORT:-7790}"
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

mkdir -p "$OUT"; rm -f "$OUT"/*.png "$OUT"/*.xml
rm -rf "$ANDROID/build/smoke-tmp"/run-* 2>/dev/null; mkdir -p "$TMP"
LOG="$OUT/smoke.log"; : > "$LOG"
say() { echo "[smoke] $*" | tee -a "$LOG"; }

SERVER_PID=""; EMU_PID=""
# tắt smoke-server còn sót (chỉ tiến trình đang nghe cổng $PORT mà dòng lệnh chứa smoke-server)
kill_smoke_server() {
  powershell -NoProfile -Command "foreach (\$x in (Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue)) { \$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + \$x.OwningProcess); if (\$p.CommandLine -like '*smoke-server*') { Stop-Process -Id \$x.OwningProcess -Force } }" >/dev/null 2>&1 || true
}
kill_smoke_server
cleanup() {
  if [ -z "${SMOKE_KEEP:-}" ]; then
    say "dọn dẹp: tắt emulator và smoke-server"
    if [ -n "$EMU_PID" ]; then   # chỉ tắt emulator do script này bật
      timeout 15 "$ADB" emu kill >/dev/null 2>&1 || true
      sleep 3
      taskkill /F /IM qemu-system-x86_64-headless.exe >/dev/null 2>&1 || true
      taskkill /F /IM emulator.exe >/dev/null 2>&1 || true
    fi
    kill_smoke_server
  fi
}
trap cleanup EXIT

# ---- 1. build ----
say "build APK debug"
( cd "$ANDROID" && ./gradlew assembleDebug --console=plain -q ) >>"$LOG" 2>&1 || { say "build thất bại (xem $LOG)"; exit 1; }
APK="$ANDROID/app/build/outputs/apk/debug/app-debug.apk"

# ---- 2. smoke-server ----
if [ ! -d "$ROOT/hub/node_modules/ws" ]; then say "npm ci trong hub/"; ( cd "$ROOT/hub" && npm ci --silent ) >>"$LOG" 2>&1; fi
say "chạy smoke-server (hub thật cổng $PORT)"
SMOKE_HUB_PORT="$PORT" node "$(win "$ROOT/ios/tools/smoke-server.js")" "$(win "$TMP")" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do [ -f "$TMP/smoke.json" ] && break; sleep 1; done
[ -f "$TMP/smoke.json" ] || { say "smoke-server không lên (xem server.log)"; exit 1; }
SMOKE="$(win "$TMP/smoke.json")"
j() { node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]])" "$SMOKE" "$1"; }
TOKEN="$(j hubToken)"; MACHINE="$(j machineId)"
S_CHAT="$(j chat)"; S_PERM="$(j perm)"; S_ASK="$(j ask)"; S_LIMIT="$(j limit)"; S_IDE="$(j ide)"; S_PONDER="$(j ponder)"; WORK="$(j work)"
say "máy $MACHINE; phiên perm $S_PERM"

# ---- 3. emulator ----
if ! "$EMU" -list-avds | grep -qx "$AVD"; then
  say "tạo AVD $AVD"
  echo no | "$AVDMGR" create avd -n "$AVD" -k "system-images;android-36.1;google_apis;x86_64" -d pixel_6 --force >>"$LOG" 2>&1
  sed -i 's/^hw.ramSize=.*/hw.ramSize=3072/' "$HOME/.android/avd/$AVD.avd/config.ini" 2>/dev/null || true
fi
if ! "$ADB" devices | grep -q "emulator-"; then
  say "khởi động emulator (nền, không cửa sổ)"
  "$EMU" -avd "$AVD" -no-window -no-audio -no-snapshot -gpu "${SMOKE_GPU:-host}" -no-boot-anim >"$OUT/emulator.log" 2>&1 &
  EMU_PID=$!
fi
"$ADB" wait-for-device
for i in $(seq 1 180); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
say "emulator đã boot"
sleep 5
a() { "$ADB" "$@"; }
a shell settings put global window_animation_scale 0 >/dev/null
a shell settings put global transition_animation_scale 0 >/dev/null
a shell settings put global animator_duration_scale 0 >/dev/null

# screencap trong máy ảo có thể sập ("hasReadColorBufferDma"), nên chụp bằng lệnh console của emulator (phía host)
SHOTS="$(cygpath -u "$LOCALAPPDATA")/Temp/ccremote-smoke-shots"   # đường dẫn không có dấu cách (lệnh console tách theo dấu cách)
shot() {
  sleep "${2:-3}"
  rm -rf "$SHOTS"; mkdir -p "$SHOTS"
  "$ADB" emu screenrecord screenshot "$(cygpath -w "$SHOTS")" >/dev/null 2>&1
  for i in $(seq 1 20); do ls "$SHOTS"/*.png >/dev/null 2>&1 && break; sleep 0.5; done
  sleep 0.5
  mv "$SHOTS"/*.png "$OUT/$1.png" 2>/dev/null && say "ảnh $1.png" || say "KHÔNG chụp được $1"
}
dump() { a shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; a pull /sdcard/ui.xml "$(win "$OUT/ui-$1.xml")" >/dev/null 2>&1; }
tap_text() {   # tap_text <chữ> [thứ tự]
  dump tap
  local xy; xy="$(node "$(win "$HERE/ui-tap.js")" "$(win "$OUT/ui-tap.xml")" "$1" "${2:-0}")" || { say "không tìm thấy nút \"$1\""; return 1; }
  a shell input tap $xy; say "bấm \"$1\" ($xy)"
}
start() { a shell am start -W -n "$PKG/.MainActivity" "$@" >/dev/null; }

# ---- 4. cài app ----
a uninstall "$PKG" >/dev/null 2>&1 || true
say "cài APK"
ok=""
for i in 1 2 3 4; do
  a install -r -g "$(win "$APK")" >>"$LOG" 2>&1 && { ok=1; break; }
  say "cài APK lần $i chưa được, thử lại"; sleep 8
done
[ -n "$ok" ] || { say "cài APK thất bại"; exit 1; }
a shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true

# ---- 5. màn hình ----
start
shot 01-login 4

start --es smoke_hub "http://10.0.2.2:$PORT" --es smoke_token "$TOKEN" --es smoke_machine "$MACHINE" --es smoke_screen home
shot 02-home 6

start --es smoke_open "$S_CHAT"
shot 03-chat-markdown 5
a shell input swipe 540 600 540 1800 300   # kéo lên đọc tin cũ
shot 03b-chat-scroll-up 1

start --es smoke_open "$S_IDE"
shot 04-ide-table 6
a shell input swipe 540 1700 540 600 300
shot 04b-ide-table-scroll 1

start --es smoke_open "$S_PERM"
shot 05-perm 6
dump perm

start --es smoke_open "$S_ASK"
shot 06-ask 5

start --es smoke_open "$S_LIMIT"
shot 07-limit 5

start --es smoke_open "$S_PONDER"
shot 08-ponder 5

start --es smoke_screen settings
shot 09-settings 4

start --es smoke_screen project
shot 10-project 5

start --es smoke_screen new
shot 11-new-session 4

# ---- 6. bấm Cho phép trong app ----
start --es smoke_open "$S_PERM"
sleep 5
if tap_text "Cho phép"; then shot 12-perm-allowed 5; fi

# ---- 7. thông báo khi app ở nền ----
say "đưa app ra nền, gửi tin xin quyền mới vào phiên perm"
a shell input keyevent KEYCODE_HOME
sleep 3
node "$(win "$HERE/hub-call.js")" "$SMOKE" sessions.send "{\"id\":\"$S_PERM\",\"text\":\"PERM lan hai: ghi file khi app o nen\"}" >>"$LOG" 2>&1
sleep 8
a shell cmd statusbar expand-notifications
sleep 2
shot 13-notification-shade 1
dump shade
if tap_text "Cho phép"; then
  say "đã bấm Cho phép trên thông báo"
  sleep 4
  shot 14-notification-after-allow 1
else
  say "KHÔNG thấy nút Cho phép trên thông báo"
fi
a shell cmd statusbar collapse
sleep 1
STATUS="$(node "$(win "$HERE/hub-call.js")" "$SMOKE" sessions.get "{\"id\":\"$S_PERM\"}" 2>&1 | tr -d '\r' | head -c 600)"
say "trạng thái phiên perm sau khi bấm: $(echo "$STATUS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.status+' pending='+j.pending)}catch{console.log(s.slice(0,200))}})")"

a shell am start -W -n "$PKG/.MainActivity" --es smoke_open "$S_PERM" >/dev/null
shot 15-perm-after-notification 5

# ---- 8. nhật ký lỗi của app ----
a logcat -d -s AndroidRuntime:E 2>/dev/null | tail -30 > "$OUT/crash.log"
say "xong. Ảnh ở $OUT"
