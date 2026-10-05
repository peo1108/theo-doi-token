#!/usr/bin/env bash
# Sao lưu DB của hub (an toàn khi hub đang chạy), giữ 7 bản gần nhất.
#   cc-hub-backup /var/lib/cc-hub/hub.db /var/backups/cc-hub
set -euo pipefail
DB="${1:?đường dẫn hub.db}"
DIR="${2:?thư mục sao lưu}"
[ -f "$DB" ] || exit 0
mkdir -p "$DIR"
sqlite3 "$DB" ".backup '$DIR/hub-$(date +%F).db'"
ls -1t "$DIR"/hub-*.db 2>/dev/null | tail -n +8 | xargs -r rm -f
