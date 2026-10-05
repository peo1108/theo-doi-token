#!/usr/bin/env bash
# Cập nhật hub sau khi kéo code mới về VPS: cài lại thư viện, khởi động lại dịch vụ, kiểm tra.
#   cd <repo> && git pull && sudo bash hub/deploy/update.sh
set -euo pipefail
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Cần chạy bằng root (sudo)"; exit 1; }
(cd "$HUB_DIR" && npm ci --omit=dev --no-audit --no-fund)
chmod -R a+rX "$HUB_DIR"
systemctl restart cc-hub
sleep 1
curl -fsS http://127.0.0.1:7790/v1/health && echo && systemctl --no-pager --lines=5 status cc-hub
