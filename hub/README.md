# CC Remote Hub

Trạm trung chuyển trên VPS giữa app iOS **CC Remote** và tracker trên PC của từng người. Điện thoại chỉ cần internet
(không cần Tailscale), nhiều người dùng tách biệt nhau, đăng nhập một lần dùng mãi. Thiết kế:
[`docs/superpowers/specs/2026-10-05-cc-remote-hub-design.md`](../docs/superpowers/specs/2026-10-05-cc-remote-hub-design.md).

Hub **không lưu nội dung phiên** (tin nhắn, code, ảnh): chỉ chuyển giữa app và PC cùng tài khoản. Trong DB chỉ có tài
khoản, thiết bị, máy (token lưu dạng băm), topic ntfy và nhật ký đăng nhập.

## Cài lên VPS (một lần)

Cần: VPS Ubuntu, tên miền có bản ghi A trỏ về IP VPS (Cloudflare để **DNS only**).

```bash
# trên VPS, bằng root — repo phải nằm ngoài /root và /home
git clone <repo> /opt/theo-doi-token        # hoặc scp thư mục lên /opt/theo-doi-token
cd /opt/theo-doi-token
bash hub/deploy/setup.sh                    # DOMAIN=... để đổi tên miền

sudo -u cchub HUB_DATA=/var/lib/cc-hub node hub/hub.js init <tên>   # tài khoản admin
```

Nên thêm khoá SSH vào `/root/.ssh/authorized_keys` **trước** khi chạy: script sẽ tắt đăng nhập bằng mật khẩu. Chưa có
khoá thì script giữ mật khẩu và nhắc đổi (`passwd`).

## Mời bạn bè

```bash
sudo -u cchub HUB_DATA=/var/lib/cc-hub node hub/hub.js invite    # in mã kiểu ABCD-EFGH, dùng một lần, 24 giờ
```

Bạn bè mở app → **Có mã mời** → nhập mã, tự đặt tên + mật khẩu (admin không biết mật khẩu của họ).

Quản lý: `users`, `lock <tên>`, `unlock <tên>`, `delete <tên>` (khoá / xoá có hiệu lực trong ≤ 30 giây).

## Ghép PC

Dashboard trên PC (`http://127.0.0.1:7788`) → thẻ **Điện thoại** → khối **Hub (VPS)** → nhập địa chỉ hub, tên, mật khẩu →
**Ghép máy**. PC chỉ lưu khoá máy trong `data/hub.json` (không lưu mật khẩu) và tự kết nối ra hub mỗi khi tracker chạy.

## Cập nhật

```bash
cd /opt/theo-doi-token && git pull && sudo bash hub/deploy/update.sh
```

## Vận hành

- Log: `journalctl -u cc-hub -f` · Caddy: `journalctl -u caddy -f`
- Sao lưu DB: `/var/backups/cc-hub/hub-YYYY-MM-DD.db` (03:30 mỗi đêm, giữ 7 bản)
- Kiểm tra: `curl https://<tên miền>/v1/health` → `{"ok":true,"proto":1}`
