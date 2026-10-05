# Theo dõi token Claude Code

Dashboard local đọc log thật của Claude Code (`~/.claude/projects/**/*.jsonl`): token vào/ra, cache, chi phí quy đổi,
cửa sổ 5 giờ, ngữ cảnh từng phiên, vỡ cache, subagent, effort, lịch sử 90 ngày, ngân sách và cảnh báo Windows.
Chỉ cần Node.js, không cài thêm gói nào.

## Chạy

| Cách | Lệnh |
|---|---|
| Icon khay + mở dashboard | nháy đúp `start.bat` |
| Tự chạy khi đăng nhập Windows | `powershell -ExecutionPolicy Bypass -File autostart.ps1` (tắt: thêm `-Uninstall`) |
| Chỉ server, xem log | `node tracker.js serve` → http://127.0.0.1:7788 |
| Bảng trong terminal | `node tracker.js report` |
| Dòng trạng thái | `node tracker.js status` |
| Số liệu Prometheus | `node tracker.js metrics` hoặc http://127.0.0.1:7788/metrics |

Icon khay: xám = chưa mở cửa sổ 5 giờ · xanh = bình thường · vàng = cao hơn trung bình · đỏ = vượt ngưỡng/ngân sách.
Nháy đúp để mở dashboard, chuột phải → Thoát để tắt cả server.

## File

| File | Vai trò |
|---|---|
| `tracker.js` | quét log, lưu dữ liệu, server, cảnh báo, `/metrics` |
| `analytics.js` | phần tính toán dùng chung (giá, cửa sổ 5h, vỡ cache…) cho server và dashboard |
| `dashboard.html` | giao diện |
| `models.json` | bảng giá & màu từng model — sửa ở đây khi giá đổi hoặc có model mới |
| `tray.ps1`, `autostart.ps1`, `start.bat` | icon khay & tự chạy |
| `data/usage.json` | chi tiết 7 ngày + tổng hợp theo ngày 90 ngày (tự tạo) |
| `data/config.json` | ngân sách & ngưỡng cảnh báo (sửa trên dashboard) |
| `data/alerts.json` | lịch sử cảnh báo |

## Cách tính

- **Bỏ trùng**: một lượt trả lời có thể được ghi nhiều dòng cùng `message.id`; giữ giá trị lớn nhất từng trường.
- **Chi phí** = token × giá niêm yết của đúng model đó (`models.json`); ghi cache 5′ = 1,25× đầu vào, 1h = 2× đầu vào;
  fast mode ×2. Nếu bạn dùng gói Pro/Max thì đây chỉ là con số quy đổi để so sánh, bạn không bị tính tiền theo nó.
- **Cửa sổ 5 giờ** là ước lượng: bắt đầu ở giờ tròn của tin nhắn đầu tiên, kéo dài 5 giờ. Anthropic không công bố
  hạn mức chính xác nên dashboard so với các cửa sổ trước của chính bạn.
- **Ngữ cảnh** của một lượt = input + ghi cache + đọc cache.
- **Vỡ cache**: lượt phải ghi lại ≥ 50% ngữ cảnh (trừ lượt đầu). Nguyên nhân: ngữ cảnh giảm mạnh → compact;
  nghỉ quá TTL (1h nếu phiên dùng cache 1h, ngược lại 5 phút) → hết hạn; khác model lượt trước → đổi model;
  còn lại → prefix thay đổi (CLAUDE.md, MCP, tool…). "Tốn thêm" = giá ghi − giá đọc của phần bị ghi lại.
- **Lịch sử**: lần chạy đầu đọc toàn bộ log còn trên máy (Claude Code giữ ~30 ngày) để lấp các ngày cũ; sau đó mỗi
  ngày được chốt khi ra khỏi cửa sổ 7 ngày và giữ 90 ngày.

## Cảnh báo

Server kiểm tra mỗi phút và gửi thông báo Windows (mỗi loại một lần) khi:
ngân sách ngày/tuần đạt 80% và 100% · cửa sổ 5h dự kiến vượt N lần trung bình · cache hit 1 giờ qua thấp hơn ngưỡng ·
một phiên đang chạy có ngữ cảnh vượt ngưỡng (báo lại mỗi khi tăng thêm 100K).

## Monitoring chuẩn (tuỳ chọn)

**Prometheus + Grafana** (cần Docker Desktop):

```bat
set HOST=0.0.0.0 && node tracker.js serve
cd monitoring && docker compose up -d
```

Grafana ở http://localhost:3000 (admin/admin), datasource Prometheus đã cài sẵn. Các metric: `claude_code_tokens_24h`,
`claude_code_cost_usd_24h`, `claude_code_cost_usd_today`, `claude_code_window_cost_usd`, `claude_code_window_reset_seconds`,
`claude_code_burn_usd_per_minute`, `claude_code_cache_hit_ratio_1h`…

**Telemetry gốc của Claude Code** (OpenTelemetry, có thêm số dòng code, commit, PR, thời gian hoạt động).
Thêm vào `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "prometheus"
  }
}
```

Prometheus trong `monitoring/prometheus.yml` đã có sẵn job `claude-code-otel` (cổng 9464). Muốn đẩy về một collector
OTLP thì dùng `"OTEL_METRICS_EXPORTER": "otlp"` cùng `OTEL_EXPORTER_OTLP_PROTOCOL` và `OTEL_EXPORTER_OTLP_ENDPOINT`.
Tài liệu: https://code.claude.com/docs/en/monitoring-usage
