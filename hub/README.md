# CC Remote Hub

Trạm trung chuyển trên VPS giữa app iOS **CC Remote** và tracker trên PC của từng người. Điện thoại chỉ cần internet,
nhiều người dùng tách biệt nhau, đăng nhập một lần dùng mãi. Mở tên miền của hub trên trình duyệt là trang quản trị. Thiết kế:
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

## Tạo tài khoản (trang web)

Mở `https://<tên miền>`, đăng nhập admin → tab **Quản trị** → **Tạo tài khoản** (tên + mật khẩu ban đầu, có nút tạo
mật khẩu ngẫu nhiên), gửi cho người dùng. Cũng ở đó: **Đặt lại mật khẩu** (không đá máy đang dùng), **Khoá** (cắt mọi
kết nối ngay), **Mở khoá**, **Xoá**.

Mỗi người dùng đăng nhập trang web để: đổi mật khẩu, xem PC (online / tắt, đổi tên, ngắt), xem và thu hồi thiết bị đã
đăng nhập, đăng ký thông báo ntfy, đăng xuất mọi nơi. Đăng nhập web dùng cookie `HttpOnly; Secure; SameSite=Strict`,
không tự hết hạn.

Dòng lệnh vẫn còn khi cần: `sudo -u cchub HUB_DATA=/var/lib/cc-hub node hub/hub.js users|lock|unlock|delete <tên>`
(khoá / xoá bằng dòng lệnh có hiệu lực trong ≤ 30 giây; trên web thì ngay lập tức).

## Ghép PC

Dashboard trên PC (`http://127.0.0.1:7788`) → thẻ **Điện thoại** → khối **Hub (VPS)** → nhập địa chỉ hub, tên, mật khẩu →
**Ghép máy**. PC chỉ lưu khoá máy trong `data/hub.json` (không lưu mật khẩu) và tự kết nối ra hub mỗi khi tracker chạy.

## Cập nhật

```bash
cd /opt/theo-doi-token && git pull && sudo bash hub/deploy/update.sh
```

Thư mục trên VPS chép bằng scp (không có git): chép lại các file đã đổi trong `hub/` (lấy từ git cho đúng xuống dòng LF,
vd. `git show HEAD:hub/router.js > router.js`, nên sao lưu bản cũ trên VPS trước) vào `/opt/theo-doi-token/hub/` rồi chạy
`sudo bash hub/deploy/update.sh` (cài lại thư viện, khởi động lại, kiểm tra `/v1/health`).

## Vận hành

- Log: `journalctl -u cc-hub -f` · Caddy: `journalctl -u caddy -f`
- Sao lưu DB: `/var/backups/cc-hub/hub-YYYY-MM-DD.db` (03:30 mỗi đêm, giữ 7 bản)
- Kiểm tra: `curl https://<tên miền>/v1/health` → `{"ok":true,"proto":1}`
