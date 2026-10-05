# Thay đổi

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
