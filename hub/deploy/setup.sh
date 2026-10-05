#!/usr/bin/env bash
# Cài CC Remote Hub lên VPS Ubuntu — chạy MỘT lần bằng root, từ trong thư mục repo đã đưa lên VPS:
#
#   bash hub/deploy/setup.sh                      # tên miền mặc định clauderc.caesarvn.xyz
#   DOMAIN=hub.vidu.com bash hub/deploy/setup.sh
#
# Cài: Node 24, Caddy (HTTPS tự động), user hệ thống cchub, dịch vụ systemd cc-hub, tường lửa (22/80/443),
# sao lưu DB mỗi đêm (giữ 7 bản). Tắt đăng nhập SSH bằng mật khẩu CHỈ KHI root đã có khoá SSH.
set -euo pipefail

DOMAIN="${DOMAIN:-clauderc.caesarvn.xyz}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HUB_DIR="$REPO_DIR/hub"
DATA_DIR=/var/lib/cc-hub
BACKUP_DIR=/var/backups/cc-hub

[ "$(id -u)" -eq 0 ] || { echo "Cần chạy bằng root (sudo)"; exit 1; }
[ -f "$HUB_DIR/hub.js" ] || { echo "Không thấy $HUB_DIR/hub.js — chạy script từ trong repo"; exit 1; }
case "$REPO_DIR" in
  /root/*|/home/*) echo "Repo đang ở $REPO_DIR — dịch vụ (user cchub, ProtectHome) không đọc được. Chuyển repo vào /opt, ví dụ: mv $REPO_DIR /opt/theo-doi-token"; exit 1;;
esac
say() { printf '\n==> %s\n' "$*"; }

say "Gói hệ thống"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw sqlite3 debian-keyring debian-archive-keyring apt-transport-https

say "Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -e 'require("node:sqlite")' || { echo "Node $(node -v) chưa có node:sqlite (cần ≥ 22.13)"; exit 1; }

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "User cchub + thư mục dữ liệu"
id cchub >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin cchub
install -d -m 700 -o cchub -g cchub "$DATA_DIR"
install -d -m 700 -o cchub -g cchub "$BACKUP_DIR"
chmod -R a+rX "$HUB_DIR"
(cd "$HUB_DIR" && npm ci --omit=dev --no-audit --no-fund)

say "Dịch vụ cc-hub"
sed -e "s#@HUB_DIR@#$HUB_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" "$HUB_DIR/deploy/cc-hub.service" > /etc/systemd/system/cc-hub.service
systemctl daemon-reload
systemctl enable --now cc-hub
systemctl restart cc-hub

say "Caddy → 127.0.0.1:7790 ($DOMAIN)"
sed -e "s#@DOMAIN@#$DOMAIN#g" "$HUB_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

say "Tường lửa"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

say "Sao lưu mỗi đêm 03:30 (giữ 7 bản)"
install -m 755 "$HUB_DIR/deploy/backup.sh" /usr/local/bin/cc-hub-backup
printf 'SHELL=/bin/sh\n30 3 * * * cchub /usr/local/bin/cc-hub-backup %s %s\n' "$DATA_DIR/hub.db" "$BACKUP_DIR" > /etc/cron.d/cc-hub-backup

say "SSH"
if [ -s /root/.ssh/authorized_keys ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-cc-hub.conf
  rm -f /etc/ssh/sshd_config.d/99-cc-hub.conf   # bản cũ: thua 50-cloud-init.conf (sshd lấy giá trị gặp trước)
  (systemctl reload ssh || systemctl reload sshd) && echo "Đã tắt đăng nhập SSH bằng mật khẩu (dùng khoá)."
else
  echo "!! Root chưa có khoá SSH (/root/.ssh/authorized_keys) — GIỮ đăng nhập mật khẩu. Thêm khoá rồi chạy lại script để tắt."
  echo "!! Nhớ đổi mật khẩu root: passwd"
fi

say "Kiểm tra"
sleep 1
curl -fsS http://127.0.0.1:7790/v1/health && echo
echo
echo "Xong. Việc tiếp theo:"
echo "  1. Tạo tài khoản admin:  sudo -u cchub HUB_DATA=$DATA_DIR node $HUB_DIR/hub.js init <tên>"
echo "  2. Mời bạn bè:            sudo -u cchub HUB_DATA=$DATA_DIR node $HUB_DIR/hub.js invite"
echo "  3. Mở https://$DOMAIN/v1/health trên điện thoại để thử HTTPS"
