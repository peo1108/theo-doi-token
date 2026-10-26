# Thay đổi

## Chưa phát hành

- App: **xem được ảnh Claude xem trên máy** — ảnh Claude mở bằng Read, ảnh chụp màn hình của tool, ảnh dán vào khung
  chat VS Code. Ảnh hiện ngay dưới dòng tool / lời nhắn, bấm để xem cỡ đầy đủ (trước đây chỉ thấy chữ `[ảnh]`).

## v1.2.0 — 2026-10-06

- **Hub trên VPS** thay cho Tailscale: điện thoại chỉ cần internet, không cần VPN. PC tự kết nối ra hub (không mở cổng),
  app đăng nhập bằng tài khoản hub một lần là dùng mãi. Nhiều người dùng chung một hub, mỗi người chỉ thấy máy của mình.
- **Trang web của hub** (`https://clauderc.caesarvn.xyz`): xem / đổi tên / thu hồi máy và thiết bị, đổi mật khẩu,
  đăng ký thông báo ntfy; admin tạo / khoá / xoá tài khoản, đặt lại mật khẩu.
- App: **gửi ảnh** từ điện thoại, tin nhắn dài không còn giới hạn 1 MB.
- Thông báo ntfy do hub gửi, mỗi tài khoản một topic riêng tự cấp — không phải tự đặt topic.
- Phiên VS Code: **xin quyền hiện cả trên máy lẫn điện thoại**, bên nào trả lời trước thì được. Trước đây ngồi máy lúc
  Claude hỏi rồi bỏ đi thì điện thoại không thấy câu hỏi.
- Cần **Node.js 22 trở lên** (để kết nối hub); dashboard báo rõ nếu máy đang chạy bản cũ hơn.
- Bỏ đường Tailscale và mã ghép 6 số cũ.

## v1.1.0 — 2026-10-05

- **Điện thoại (CC Remote)**: app iOS điều khiển Claude Code trên máy qua Tailscale — mở/tiếp tục phiên, duyệt quyền,
  trả lời câu hỏi, ngắt, đổi chế độ quyền/model, xem hạn mức; hết hạn mức thì đổi tài khoản rồi chạy tiếp ngay trong
  phiên. Ghép bằng mã 6 số, thông báo khi app đóng qua ntfy (tuỳ chọn). Thẻ Điện thoại trên dashboard.
- Cài đặt phiên trên điện thoại: model, Effort, Thinking, Fast mode, đổi model khi bị flag, output style (áp dụng ngay
  giữa phiên, giữ khi mở lại); gợi ý lệnh `/` khi gõ.
- Điều khiển **phiên đang mở trong VS Code / terminal** qua hook, luôn sẵn sàng (không cần `/phone`): nhắn lúc rảnh hay
  đang chạy, bấm dừng giữa chừng, xin quyền chuyển sang điện thoại khi m rời máy; dòng Thinking… · N tokens như IDE.
- App: phiên xếp theo dự án (phiên đang chạy luôn ở trên), tạo phiên mới trong dự án; khung trả lời giống VS Code.
- IPA chưa ký được build tự động bằng GitHub Actions (release `ios-latest`), cài bằng ESign.

## v1.0.1 — 2026-10-05

- Cập nhật nhanh hơn: dashboard 10 giây, icon khay 15 giây, % hạn mức của tài khoản đang dùng mỗi phút
  (tài khoản khác vẫn 5 phút).

## v1.0.0 — 2026-10-05

Bản phát hành đầu tiên.

- Dashboard local đọc log Claude Code: token vào/ra, cache, chi phí quy đổi theo giá từng model, lịch sử 90 ngày.
- Cửa sổ 5 giờ theo mốc reset thật của Anthropic, % hạn mức 5h/tuần, dự kiến giờ chạm 100%.
- Ngữ cảnh từng phiên, phát hiện vỡ cache, subagent, effort, ngân sách ngày/tuần.
- Cảnh báo Windows: ngân sách, hạn mức tài khoản, cache hit thấp, ngữ cảnh dài, đăng nhập sắp hết hạn.
- Nhiều tài khoản Claude: mỗi tài khoản `/login` một lần, đổi bằng một cú bấm (khay, dashboard) hoặc `cc-switch`;
  số liệu và hạn mức tách theo tài khoản; gợi ý tài khoản còn nhiều hạn mức.
- Icon khay với menu nổi (tự theo giao diện sáng/tối của Windows).
- `/metrics` cho Prometheus/Grafana (tuỳ chọn).
