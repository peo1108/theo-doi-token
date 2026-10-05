# Quản lý nhiều tài khoản Claude Code — thiết kế

Ngày: 2026-10-05 · Trạng thái: chờ duyệt

## 1. Mục tiêu

Dùng nhiều tài khoản Claude (gói Pro/Max) trên cùng một máy, vừa để **tách công việc** (cá nhân / công ty…) vừa để
**theo dõi hạn mức** của từng tài khoản và đổi sang tài khoản còn nhiều hạn mức.

Thành công khi:

- Mỗi tài khoản chỉ `/login` một lần; sau đó đổi qua lại bằng một cú bấm (khay, dashboard) hoặc `cc-switch <tên>`.
- Lịch sử, cài đặt, CLAUDE.md, MCP (kể cả token MCP), model, effort dùng chung, giống hệt nhau giữa các tài khoản.
- Dashboard cho thấy với từng tài khoản: % cửa sổ 5 giờ, % tuần, giờ reset, chi phí quy đổi hôm nay/tuần, hạn đăng nhập.
- Không bao giờ mất đăng nhập của tài khoản nào vì đổi qua lại.

Ngoài phạm vi: tự động đổi tài khoản; chạy song song nhiều tài khoản cùng lúc; hỗ trợ macOS/Linux (code nên không
khoá chết vào Windows nhưng chỉ kiểm thử trên Windows); mã hoá thêm hồ sơ ngoài mức Claude Code đang lưu.

## 2. Hiện trạng đã khảo sát

- Đăng nhập nằm ở **hai file**:
  - `~/.claude/.credentials.json`: `claudeAiOauth` (`accessToken`, `refreshToken`, `expiresAt`,
    `refreshTokenExpiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`), `organizationUuid`, và `mcpOAuth`
    (token các MCP server — **dùng chung**, không thuộc tài khoản Claude).
  - `~/.claude.json`: `oauthAccount` (`accountUuid`, `emailAddress`, `organizationUuid`, `displayName`,
    `organizationType`, …) cùng rất nhiều dữ liệu dùng chung (`projects`, cache, …).
- Refresh token **xoay vòng**: Claude Code làm mới token và ghi lại file; bản cũ mất hiệu lực.
- `~/.claude.json` có `cachedUsageUtilization` = `{ fetchedAtMs, accountUuid, utilization: { five_hour, seven_day, … } }`
  với `utilization` (%) và `resets_at` thật từ Anthropic. Đây là cache nội bộ không có tài liệu → dùng kiểu "có thì tốt".
- Log `~/.claude/projects/**/*.jsonl` **không** ghi tài khoản.
- Đường dẫn: có `CLAUDE_CONFIG_DIR` → `<dir>/.credentials.json` và `<dir>/.claude.json`; không có →
  `~/.claude/.credentials.json` và `~/.claude.json`. `<claude-dir>` trong tài liệu này = `CLAUDE_CONFIG_DIR` hoặc `~/.claude`.

## 3. Phương án đã chọn

**Đổi đúng các trường đăng nhập trong hai file** (phương án A). Đã loại phương án dùng `claude setup-token` +
`CLAUDE_CODE_OAUTH_TOKEN` vì chạy song song làm mất khả năng gán số liệu theo tài khoản và không có hạn mức thật.

Khi đổi: còn phiên Claude Code đang chạy thì **cảnh báo nhưng vẫn đổi** (lựa chọn của người dùng); rủi ro ghi đè
được xử lý bằng cơ chế đồng bộ ở mục 5.3.

## 4. Thành phần

| File | Vai trò |
|---|---|
| `accounts.js` (mới) | Thư viện + CLI: hồ sơ, nhận diện tài khoản trong file, `switchTo`, `snapshotActive`, `sync`, tìm tiến trình Claude Code, dòng thời gian, khoá, sao lưu. Không phụ thuộc `tracker.js`. |
| `cc-switch.cmd` (mới) | `@node "%~dp0accounts.js" %*` — thêm thư mục vào PATH để gõ `cc-switch` ở đâu cũng được. |
| `tracker.js` | Gọi `sync()` mỗi lần quét; gán `account` cho từng lượt; `daily` theo tài khoản; API và cảnh báo mới. |
| `analytics.js` | Hàm `accountAt(log, t)`; nhóm/lọc theo `account`; cửa sổ 5h ước lượng tính riêng từng tài khoản; `suggestAccount`. |
| `dashboard.html` | Thẻ "Tài khoản" + bộ lọc tài khoản cho các biểu đồ có sẵn + hộp thoại xử lý ghi đè. |
| `tray.ps1` | Menu con "Tài khoản ▸" (✓ tài khoản đang chọn, bấm để đổi); tooltip có tên tài khoản; báo cần `/login`. |
| `test/*.test.js` (mới) | `node --test`, không thêm gói. |
| `README.md` | Thêm mục "Nhiều tài khoản". |

### 4.1 CLI

```text
cc-switch                 liệt kê: tên, email, gói, %5h, %tuần, hạn đăng nhập, dấu * ở tài khoản đang chọn
cc-switch <tên|id|email>  đổi tài khoản (khớp không phân biệt hoa thường, cho phép tiền tố duy nhất)
cc-switch rename <tên|id> <tên mới>
cc-switch remove <tên|id> xoá hồ sơ (không xoá được tài khoản đang chọn)
cc-switch keep            giữ tài khoản đang nằm trong file làm tài khoản đang chọn (xử lý ghi đè, mục 5.3)
```

Mã thoát: 0 thành công, 1 lỗi, 2 không tìm thấy / tên mơ hồ. Cảnh báo phiên đang chạy in ra stderr, không đổi mã thoát.

## 5. Dữ liệu và luồng

### 5.1 Lưu trữ

- `<claude-dir>/account-profiles/<accountUuid>.json`:
  `{ v: 1, id, name, email, plan, oauth: <claudeAiOauth>, organizationUuid, oauthAccount, usage: <cachedUsageUtilization|null>, savedAt }`
- `<claude-dir>/account-profiles/backup/<timestamp>-{credentials,claude}.json` — 5 cặp gần nhất.
- `<claude-dir>/account-profiles/.lock` — `{ pid, t }`, coi là hết hạn sau 30 giây.
- `data/account-log.json` (trong dự án): `{ v: 1, entries: [{ t, id, reason: 'init'|'switch'|'login'|'keep' }], conflict: null | { fileId, chosenId, since } }`.
  Mục cuối = **tài khoản đang chọn**. Lần đầu tự thêm `{ t: 0, id: <tài khoản trong file>, reason: 'init' }`.

Tên mặc định của hồ sơ = phần trước `@` của email; trùng thì thêm số.

### 5.2 Đổi tài khoản — `switchTo(target, { force })`

1. Lấy khoá; không lấy được → lỗi "đang có thao tác đổi khác".
2. Đọc hai file, kiểm tra định dạng (mục 6). Nhận diện tài khoản X trong file bằng `oauthAccount.accountUuid`
   (đối chiếu `organizationUuid`, lệch → coi như định dạng lạ).
3. `snapshot(X)`: ghi `oauth`, `organizationUuid`, `oauthAccount` hiện tại vào hồ sơ X; nếu
   `cachedUsageUtilization.accountUuid === X` thì lưu `usage`.
4. X === target → thả khoá, trả "đã ở tài khoản này".
5. Tìm tiến trình Claude Code → danh sách cảnh báo (không chặn).
6. Sao lưu hai file.
7. Ghi `.credentials.json`: thay `claudeAiOauth`, `organizationUuid`; giữ mọi khoá khác.
   Ghi `.claude.json`: thay `oauthAccount`; giữ mọi khoá khác. Ghi atomic (tmp + rename, thử lại khi EPERM/EBUSY).
8. Đọc lại, xác nhận `accountUuid` = target. Sai → thử lại bước 7 tối đa 3 lần cách 200ms; vẫn sai → khôi phục
   bản sao lưu, trả lỗi.
9. Thêm `{ t: now, id: target, reason: 'switch', running: <số phiên đang chạy> }` vào dòng thời gian; xoá `conflict`.
10. Thả khoá. Trả `{ ok, from, to, running: [...] }`.

`.claude.json` được đọc/ghi lại dưới dạng JSON (`JSON.stringify(obj, null, 2)` như Claude Code đang lưu); "giữ mọi
khoá khác" nghĩa là giá trị không đổi, không cam kết giữ nguyên định dạng khoảng trắng.

### 5.3 Đồng bộ — `sync()` (tracker gọi mỗi lần quét, tối thiểu 1 lần/phút)

Bỏ qua nếu đang có khoá. F = tài khoản trong file, I = tài khoản đang chọn.

- **Không có đăng nhập** (`claudeAiOauth` vắng, ví dụ sau `/logout`): không làm gì.
- **F chưa có hồ sơ**: tạo hồ sơ từ file, thêm `{ reason: 'login' }`, cảnh báo info "Đã thêm tài khoản {email}".
- **F === I**: nếu `oauth` / `usage` khác hồ sơ → cập nhật hồ sơ.
- **F !== I, F có hồ sơ**: cập nhật hồ sơ F từ file (giữ token mới nhất của F); đặt `conflict = { fileId: F, chosenId: I, since }`
  (nếu chưa đặt); cảnh báo warning một lần cho mỗi `since`:
  "Đăng nhập hiện là F nhưng bạn đang chọn I (phiên cũ ghi đè hoặc vừa /login)". Hai cách xử lý:
  - **Áp lại I** = `switchTo(I)`.
  - **Giữ F** = thêm `{ reason: 'keep', id: F, t: conflict.since }` và xoá `conflict`.

### 5.4 Gán số liệu theo tài khoản

- `accountAt(entries, t)` = `id` của mục cuối có `entries[k].t <= t`. Tính lúc phân tích, không lưu vào `msgs`,
  nên "Giữ F" hay sửa dòng thời gian tự làm đúng lại số liệu.
- Hàng dữ liệu (`ROW_COLS`, `INDEXED`) có thêm cột `account` (chỉ mục). Dashboard nhận thêm `accounts`
  (thông tin công khai) và `accountLog`.
- `daily`: khoá trong mỗi ngày đổi từ `model[|fast]` thành `account|model[|fast]`. `STORE_VERSION` 4 → 5 để dựng lại
  từ log còn trên máy; ngày đã chốt trước đây (cũ hơn log còn lại) nhận `account` = mục `init`.
- Mốc đổi có `running > 0` được đánh dấu trên dashboard: "có N phiên đang chạy lúc đổi — lượt sau mốc này của các
  phiên đó có thể bị tính sai tài khoản".

### 5.5 Hạn mức, gợi ý, hạn đăng nhập

- **% hiệu dụng** của một cửa sổ (`five_hour`, `seven_day`): `resets_at <= now` → 0, ngược lại `utilization`.
  Không có dữ liệu → `null` (hiện "chưa có số liệu").
- **Gợi ý** = tài khoản khác I, đăng nhập còn hạn, có `max(%5h, %tuần)` hiệu dụng nhỏ nhất; hoà thì chọn
  `resets_at` của 5h sớm hơn. Không có ứng viên → không gợi ý.
- **Cảnh báo gần hết hạn mức** (config `alertLimitPct`, mặc định 90, 0 = tắt): tài khoản I có %5h hoặc %tuần hiệu dụng
  ≥ ngưỡng → thông báo warning một lần cho mỗi cặp (cửa sổ, `resets_at`):
  "{I} đã dùng 92% cửa sổ 5h — gợi ý: {B} (đang 20%, cập nhật 3 giờ trước)".
- **Hạn đăng nhập** từ `oauth.refreshTokenExpiresAt` (vắng thì bỏ qua): còn < 3 ngày → warning; đã qua → critical
  "{tên}: cần /login lại". Mỗi mức báo một lần cho mỗi hồ sơ.
- Cửa sổ 5h **ước lượng** hiện có (`A.summary`) tính trên các lượt của tài khoản I; ngân sách ngày/tuần vẫn tính
  trên tổng mọi tài khoản.

### 5.6 API (tracker)

| Đường dẫn | Mô tả |
|---|---|
| `GET /api/accounts` | `{ active, fileAccount, conflict, accounts: [{ id, name, email, plan, usage: {fiveHour, sevenDay, fetchedAt}, loginExpiresAt, loginState (ok / soon / expired), costToday, costWeek, suggested }] }` — **không có token**. |
| `POST /api/accounts/switch` | body `{ id }` → kết quả `switchTo`. |
| `POST /api/accounts/keep` | xử lý conflict kiểu "Giữ F". |
| `POST /api/accounts/rename` | body `{ id, name }`. |
| `/api/summary` | thêm `account: { name, fiveHour, sevenDay }` cho khay. |

Mọi `POST` tới `/api/accounts/*` phải có header `X-Token-Tracker: 1` (buộc trình duyệt preflight, server không trả
CORS → trang lạ không gọi được) và nếu có `Origin` thì phải là `http://127.0.0.1:<PORT>` hoặc `http://localhost:<PORT>`.
Địa chỉ nguồn phải là loopback (kể cả khi `HOST=0.0.0.0`).

### 5.7 Khay

- Menu con "Tài khoản ▸": mỗi dòng `✓ Tên · 5h 42% · tuần 76%`, tài khoản cần `/login` có hậu tố "· cần /login".
  Bấm → `POST /api/accounts/switch`; có phiên đang chạy → balloon cảnh báo kèm số phiên.
- Tooltip / dòng tóm tắt thêm tên tài khoản đang chọn.
- Có `conflict` hoặc tài khoản `expired` → icon `warn` (không hạ icon `bad`).

### 5.8 Dashboard

- Thẻ "Tài khoản" đầu trang: bảng các tài khoản (cột như API), thanh % 5h/tuần, nhãn "Đang dùng", nhãn "Gợi ý",
  nút **Đổi**, đổi tên tại chỗ.
- Băng cảnh báo khi có `conflict` với hai nút **Áp lại {I}** / **Giữ {F}**.
- Bộ lọc "Tài khoản: Tất cả | …" áp lên các biểu đồ/bảng hiện có.
- Mốc đổi tài khoản vẽ thành vạch dọc trên biểu đồ theo thời gian.

## 6. Xử lý lỗi

| Tình huống | Xử lý |
|---|---|
| Định dạng file lạ (thiếu `claudeAiOauth.accessToken/refreshToken` hoặc `oauthAccount.accountUuid`, JSON hỏng) | Không ghi gì, lỗi "Claude Code đã đổi định dạng file đăng nhập". `sync` bỏ qua lượt đó. |
| Tiến trình khác ghi đè ngay sau khi ghi | Kiểm tra lại, thử 3 lần, khôi phục sao lưu nếu vẫn hỏng. |
| Windows khoá file (EPERM/EBUSY) | Thử lại 5 lần cách 100ms; thất bại → khôi phục sao lưu. |
| Hai thao tác đổi cùng lúc | File khoá; khoá cũ hơn 30 giây hoặc PID không còn → coi là hết hạn. |
| Không tìm được tiến trình (`Get-CimInstance` lỗi) | Vẫn đổi, cảnh báo "không kiểm tra được phiên đang chạy". |
| Hồ sơ hỏng | Bỏ qua hồ sơ đó, dashboard hiện lỗi cho đúng dòng đó. |
| Hồ sơ đích không có token | Lỗi "hồ sơ chưa có đăng nhập, hãy /login bằng tài khoản này". |

Tìm tiến trình: `Get-CimInstance Win32_Process` lọc `Name = 'claude.exe'` hoặc `CommandLine` chứa
`@anthropic-ai/claude-code` / `claude-code`; trả `{ pid, name, cwd? }`. Loại trừ chính tiến trình hiện tại.

## 7. Kiểm thử

`node --test test/` với thư mục Claude giả (biến môi trường `CLAUDE_CONFIG_DIR` trỏ vào thư mục tạm,
`TT_DATA_DIR` thay cho `data/`) và file mẫu có cả `mcpOAuth`, `projects`, `cachedUsageUtilization`:

- đổi tài khoản giữ nguyên mọi khoá khác (deep-equal phần còn lại);
- snapshot tài khoản cũ trước khi đổi; `usage` chỉ lưu khi `accountUuid` khớp;
- `sync`: tài khoản mới / trùng tài khoản đang chọn / bị ghi đè → đúng hồ sơ, đúng `conflict`, đúng cảnh báo;
- `keep` và `switchTo` xoá `conflict`;
- `accountAt` ở các mốc biên (trước mục đầu, đúng bằng `t`, sau mục cuối);
- `suggestAccount`: bỏ qua tài khoản hết hạn đăng nhập, coi cửa sổ đã reset là 0, hoà;
- mức hạn đăng nhập ok / soon / expired;
- định dạng lạ → không ghi; giả lập rename lỗi → khôi phục sao lưu; xoay vòng giữ 5 bản;
- `GET /api/accounts` không chứa chuỗi `accessToken`/`refreshToken`; `POST` thiếu header hoặc sai `Origin` → 403.

Kiểm tra tay với 2 tài khoản thật: `/login` tài khoản thứ hai → hồ sơ tự xuất hiện; đổi qua lại → `/status` trong
terminal và VS Code hiện đúng email; mở một phiên cũ rồi đổi → thấy cảnh báo, xử lý được conflict; dashboard chia số
liệu đúng sau mốc đổi.

## 8. Rủi ro còn lại

- Phụ thuộc định dạng file nội bộ của Claude Code — có kiểm tra định dạng, nhưng một bản Claude Code mới có thể làm
  công cụ ngừng đổi được cho tới khi cập nhật.
- `cachedUsageUtilization` có thể biến mất hoặc đổi cấu trúc → phần % hạn mức thật hiện "chưa có số liệu", các phần
  khác vẫn chạy.
- Đổi khi còn phiên chạy có thể làm gán sai số liệu các lượt sau mốc đổi của phiên đó (đã đánh dấu trên dashboard).
