# Theo dõi token Claude Code

Dashboard local đọc log thật của Claude Code (`~/.claude/projects/**/*.jsonl`): token vào/ra, cache, chi phí quy đổi,
cửa sổ 5 giờ, ngữ cảnh từng phiên, vỡ cache, subagent, effort, lịch sử 90 ngày, ngân sách và cảnh báo Windows.
Chỉ cần Node.js, không cài thêm gói nào.

## Cài đặt

1. **Cần có:** Windows 10/11, [Node.js](https://nodejs.org) bản LTS (18 trở lên), Claude Code đã đăng nhập (`/login`).
2. Giải nén vào một thư mục cố định, ví dụ `Documents\theo-doi-token` (đừng chạy thẳng trong file zip hay thư mục tạm).
3. Nháy đúp `start.bat`. Icon xuất hiện ở khay hệ thống và dashboard mở ở <http://127.0.0.1:7788>.
   Lần đầu tool đọc lại log Claude Code còn trên máy (~30 ngày) nên có thể mất vài giây.
4. Tuỳ chọn: tự chạy khi mở máy: `powershell -ExecutionPolicy Bypass -File autostart.ps1`.

Gỡ: chạy `autostart.ps1 -Uninstall`, chuột phải icon khay → Thoát, rồi xoá thư mục. Nếu đã dùng tính năng nhiều tài khoản,
xoá thêm `%USERPROFILE%\.claude\account-profiles\` (chứa token đăng nhập đã lưu).

**Riêng tư:** mọi số liệu nằm trên máy bạn (`data/`). Dashboard chỉ nghe ở 127.0.0.1 (server cho điện thoại cũng vậy, ra ngoài qua Tailscale). Kết nối ra ngoài duy nhất là hỏi
hạn mức 5h/tuần ở `api.anthropic.com` bằng chính token Claude Code của bạn (giống lệnh `/usage`).

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
| Ghép điện thoại | dashboard → thẻ Điện thoại, hoặc `node remote.js pair` |
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
| `remote.js` | điều khiển từ điện thoại: phiên Claude, ghép thiết bị, ntfy (xem [Điện thoại](#điện-thoại-cc-remote)) |
| `ios/` | app iOS CC Remote (SwiftUI, build bằng GitHub Actions) |
| `data/remote.json` | thiết bị đã ghép (token dạng băm), mã ghép, topic ntfy |
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

## Điện thoại (CC Remote)

Điều khiển Claude Code trên máy tính từ iPhone, thay cho Remote Control chính chủ (vốn gắn với một tài khoản). Phiên chạy
trên máy tính, điện thoại chỉ gửi lời nhắn và nhận kết quả, nên đổi tài khoản giữa chừng vẫn tiếp tục đúng phiên đó.

**App làm được:** mở phiên mới ở thư mục dự án bất kỳ · mở lại phiên cũ (kể cả phiên chạy trong terminal) · xem trả lời,
tool đang chạy, kết quả · **duyệt quyền** (Cho phép / Luôn cho phép / Từ chối), trả lời câu hỏi của Claude, duyệt kế
hoạch · ngắt · **cài đặt phiên giống VS Code**: đổi model (danh sách lấy thẳng từ Claude Code), Effort (Low → Max),
Thinking, Fast mode, tự đổi model khi tin nhắn bị flag, chế độ quyền, output style; áp dụng ngay giữa phiên · gõ `/` để
chọn lệnh (`/compact`, `/context`, `/review`…) · xem % hạn mức 5h/7 ngày · **hết hạn mức → "Đổi sang X & tiếp tục"** (đổi
tài khoản, khởi động lại phiên với `--resume` rồi gửi "tiếp tục").

### Cài đặt (một lần)

1. **Tailscale** (miễn phí): cài trên máy tính (`winget install tailscale.tailscale`) và iPhone (App Store), đăng nhập
   cùng một tài khoản.
2. **App iOS**: tải `CCRemote-unsigned.ipa` ở release
   [`ios-latest`](https://github.com/peo1108/theo-doi-token/releases/tag/ios-latest), ký và cài bằng ESign.
3. Mở dashboard → thẻ **Điện thoại**:
   - bấm **Mở cho điện thoại** (tương đương `tailscale serve --bg 7789`; lần đầu Tailscale có thể yêu cầu bật HTTPS
     cho tailnet theo đường link nó in ra), rồi chép địa chỉ `https://<máy>.<tailnet>.ts.net`;
   - bấm **Tạo mã ghép** (hoặc `node remote.js pair`), nhập địa chỉ + mã 6 số vào app.
4. Tuỳ chọn, **thông báo khi app đóng**: cài app **ntfy**, đặt một topic bí mật (dashboard hoặc Cài đặt trong app) và
   đăng ký đúng topic đó trong ntfy. Máy tính sẽ báo khi Claude xin quyền, hỏi bạn, hết hạn mức hoặc xong việc mà app
   không mở. Chỉ gửi tiêu đề ngắn qua ntfy.sh, không gửi code.

### Cách hoạt động

- `tracker.js serve` (khay đã tự chạy) mở thêm server `127.0.0.1:7789` (`REMOTE=0` để tắt, `REMOTE_PORT` để đổi cổng).
  Server chỉ nghe ở loopback; `tailscale serve` đưa nó ra tailnet với HTTPS, nên chỉ thiết bị của bạn vào được.
- Mỗi phiên là một tiến trình `claude -p --input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio`; xin quyền đi qua `can_use_tool` tới điện thoại. Phiên rảnh 30 phút mà không ai xem
  thì tự tắt, tin nhắn sau sẽ mở lại bằng `--resume` (lịch sử vẫn đủ).
- Mọi API cần token thiết bị (cấp khi ghép, máy tính chỉ lưu dạng băm trong `data/remote.json`). Mã ghép dùng một lần,
  hết hạn sau 10 phút, sai 5 lần thì huỷ. Thu hồi thiết bị: nút **Thu hồi** trên dashboard hoặc `node remote.js revoke <id>`.
- **Đổi tài khoản từ điện thoại** dùng đúng cơ chế `cc-switch`. Phiên mở từ điện thoại được khởi động lại khi rảnh để
  dùng tài khoản mới; phiên trong terminal/VS Code vẫn như mục [Nhiều tài khoản](#nhiều-tài-khoản).
- Đừng gửi tin vào cùng một phiên từ cả terminal lẫn điện thoại cùng lúc (hai tiến trình cùng ghi một lịch sử).

**Build app** (không cần Mac): mỗi lần đẩy thay đổi trong `ios/` lên GitHub, workflow `.github/workflows/ios.yml` build
trên macOS của GitHub Actions bằng XcodeGen, rồi đưa IPA chưa ký lên release `ios-latest`. Icon: `node ios/tools/make-icon.js`.

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
