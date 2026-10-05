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
| Chạy test | `node --test "test/*.test.js"` |
| Đổi tài khoản Claude Code | `cc-switch` (thêm thư mục dự án vào PATH) — xem [Nhiều tài khoản](#nhiều-tài-khoản) |

Icon khay: xám = chưa mở cửa sổ 5 giờ · xanh = bình thường · vàng = cao hơn trung bình · đỏ = vượt ngưỡng/ngân sách.
Bấm trái hoặc phải vào icon để mở menu: các dòng Tài khoản (bấm để đổi), Thêm tài khoản, Mở dashboard, Thoát (tắt cả server).
Nháy đúp để mở dashboard.

## File

| File | Vai trò |
|---|---|
| `tracker.js` | quét log, lưu dữ liệu, server, cảnh báo, `/metrics` |
| `analytics.js` | phần tính toán dùng chung (giá, cửa sổ 5h, vỡ cache…) cho server và dashboard |
| `dashboard.html` | giao diện |
| `models.json` | bảng giá & màu từng model — sửa ở đây khi giá đổi hoặc có model mới |
| `accounts.js` | hồ sơ tài khoản, đổi đăng nhập, dòng thời gian đổi (lõi của `cc-switch` và API `/api/accounts`) |
| `cc-switch.cmd` | lệnh đổi tài khoản trong terminal |
| `tray.ps1`, `autostart.ps1`, `start.bat` | icon khay & tự chạy |
| `tray-ui.ps1` | giao diện menu khay (dot-source từ `tray.ps1`) |
| `data/usage.json` | chi tiết 7 ngày + tổng hợp theo ngày 90 ngày (tự tạo) |
| `data/config.json` | ngân sách & ngưỡng cảnh báo (sửa trên dashboard) |
| `data/alerts.json` | lịch sử cảnh báo |
| `data/account-log.json` | dòng thời gian các lần đổi tài khoản (tự tạo) |
| `~/.claude/account-profiles/` | hồ sơ từng tài khoản + `backup/` (chứa token đăng nhập, xem [Nhiều tài khoản](#nhiều-tài-khoản)) |

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
- **Theo tài khoản**: lượt trả lời được gán cho tài khoản theo dòng thời gian các lần đổi (`data/account-log.json`).
  Lượt của phiên còn chạy lúc đổi có thể bị tính cho tài khoản mới (đánh dấu trên biểu đồ).
- **% hạn mức** lấy từ cache của Claude Code (`cachedUsageUtilization`), nên tài khoản không dùng chỉ cập nhật tới lần dùng cuối.
- **Lịch sử**: lần chạy đầu đọc toàn bộ log còn trên máy (Claude Code giữ ~30 ngày) để lấp các ngày cũ; sau đó mỗi
  ngày được chốt khi ra khỏi cửa sổ 7 ngày và giữ 90 ngày.

## Cảnh báo

Server kiểm tra mỗi phút và gửi thông báo Windows (mỗi loại một lần) khi:
ngân sách ngày/tuần đạt 80% và 100% · cửa sổ 5h dự kiến vượt N lần trung bình · cache hit 1 giờ qua thấp hơn ngưỡng ·
một phiên đang chạy có ngữ cảnh vượt ngưỡng (báo lại mỗi khi tăng thêm 100K) ·
hạn mức 5h/tuần của tài khoản đang dùng đạt `alertLimitPct`% (mặc định 90, 0 = tắt; kèm gợi ý tài khoản khác còn nhiều) ·
đăng nhập của tài khoản sắp hết hạn (< 3 ngày) hoặc đã hết hạn · phát hiện đăng nhập bị ghi đè (conflict) ·
tài khoản mới xuất hiện sau `/login`.

## Nhiều tài khoản

Đổi qua lại giữa các tài khoản Claude Code (đăng nhập OAuth) mà không phải `/login` lại. Tracker lưu mỗi tài khoản thành
một hồ sơ và đổi bằng cách ghi đè `claudeAiOauth` trong `.credentials.json` và `oauthAccount` trong `.claude.json`
(các khoá khác giữ nguyên; luôn sao lưu trước khi ghi).

| Việc | Cách |
|---|---|
| Thêm tài khoản | `/login` trong Claude Code → tự xuất hiện (khi tracker đang chạy) |
| Đổi tên | bấm vào tên trên thẻ Tài khoản của dashboard, hoặc `cc-switch rename <tài khoản> <tên mới>` |
| Đổi tài khoản | khay (bấm dòng Tài khoản) · nút **Đổi** trên dashboard · `cc-switch <tên\|email\|id>` |
| Xem / xoá / xử lý xung đột | `cc-switch` · `cc-switch remove <tài khoản>` · `cc-switch keep` |

- **Đổi khi còn phiên đang chạy**: các phiên đó vẫn giữ token cũ (dùng tài khoản cũ cho tới khi mở lại) và có thể ghi
  đè lại đăng nhập khi làm mới token. Sau khi đổi, `cc-switch` / dashboard / khay báo số phiên đang chạy. Nếu bị ghi đè,
  dashboard hiện băng cảnh báo với hai nút: **Áp lại** (về tài khoản đã chọn) hoặc **Giữ** (chấp nhận tài khoản đang
  trong file). Cách chắc nhất: đóng các phiên cũ rồi mới đổi; VS Code cần mở lại phiên.
- `cc-switch` cần thư mục dự án nằm trong `PATH`. `cc-switch <tên>` khớp chính xác trước, rồi tới tiền tố (không tìm thấy hoặc mơ hồ → mã thoát 2).
- Thẻ Tài khoản trên dashboard hiện chi phí hôm nay/tuần, hạn mức 5h/tuần và hạn đăng nhập; các lần đổi là vạch đứt trên biểu đồ. Ngưỡng cảnh báo sửa ở "Cài đặt" (`alertLimitPct`).
- **Bảo mật**: hồ sơ chứa token đăng nhập, nằm cạnh `.credentials.json` trong `~/.claude/account-profiles/`.
  Không chia sẻ, không đồng bộ lên cloud/git thư mục này. API chỉ nhận trên loopback và không bao giờ trả token.
- **Hồ sơ chỉ được làm mới khi tracker (khay/dashboard), statusline hoặc `cc-switch` đang chạy.** Trước khi `/login` bằng
  tài khoản khác, hãy chạy `cc-switch` (nó đồng bộ) để lưu token mới nhất của tài khoản đang dùng. Đừng `/logout` trước khi
  `/login` tài khoản khác: đăng xuất có thể thu hồi token đã lưu.
- **Khôi phục token từ `prev`**: mỗi lần token của hồ sơ đổi, bản cũ được giữ trong khoá `prev` (3 bản gần nhất, mới nhất
  trước; API không bao giờ trả). Nếu hồ sơ bị ghi đè nhầm token: chép `prev[0].oauth` đè vào `oauth` trong file hồ sơ
  (`~/.claude/account-profiles/<id>.json`), rồi chạy `cc-switch <tên>`.
- **Khôi phục tay**: `account-profiles/backup/` giữ 5 bản sao lưu gần nhất (cặp `<dấu thời gian>-credentials.json` +
  `<dấu thời gian>-claude.json`, trước mỗi lần ghi); chép đè lại `~/.claude/.credentials.json` và `~/.claude.json`
  (thư mục home, không nằm trong `~/.claude`; nếu đặt `CLAUDE_CONFIG_DIR` thì là hai file trong thư mục đó).

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
