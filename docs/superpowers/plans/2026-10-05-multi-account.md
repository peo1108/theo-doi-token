# Quản lý nhiều tài khoản Claude Code — kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lưu mỗi tài khoản Claude một hồ sơ, đổi bằng một cú bấm (CLI / khay / dashboard), và chia số liệu + hạn mức thật theo tài khoản.

**Architecture:** `accounts.js` (mới) sở hữu mọi thao tác với file đăng nhập: hồ sơ, đổi, đồng bộ, dòng thời gian. `analytics.js` thêm các hàm thuần (gán tài khoản theo thời gian, % hiệu dụng, gợi ý, trạng thái đăng nhập) dùng chung cho server và trình duyệt. `tracker.js` gọi `sync()` mỗi lần quét, gắn cột `account`, mở API; dashboard và khay chỉ nói chuyện qua API.

**Tech Stack:** Node.js ≥ 18 (máy đang có v24), không thêm gói npm; `node:test` + `node:assert`; PowerShell 5.1 + WinForms cho khay; HTML/JS thuần.

**Spec:** `docs/superpowers/specs/2026-10-05-multi-account-design.md`

## Global Constraints

- Không thêm dependency; test chạy bằng `node --test test/`.
- Đường dẫn: `CLAUDE_CONFIG_DIR` có → `<dir>/.credentials.json`, `<dir>/.claude.json`, `<dir>/account-profiles/`; không có → `~/.claude/.credentials.json`, `~/.claude.json`, `~/.claude/account-profiles/`. Tính lại mỗi lần gọi (không cache ở module scope) để test đổi được env.
- Thư mục dữ liệu dự án: `process.env.TT_DATA_DIR || path.join(__dirname, 'data')` (cả `tracker.js` và `accounts.js`).
- Chỉ thay `claudeAiOauth`, `organizationUuid` trong `.credentials.json` và `oauthAccount` trong `.claude.json`; mọi khoá khác giữ nguyên giá trị.
- Định dạng ghi: `.credentials.json` = `JSON.stringify(obj)` (một dòng, như hiện tại); `.claude.json` = `JSON.stringify(obj, null, 2)`.
- Ghi atomic: file tạm `${file}.${pid}.tmp` + `renameSync`, thử lại 5 lần cách 100ms khi `EPERM`/`EBUSY`/`EACCES`.
- Sao lưu giữ 5 cặp gần nhất; khoá hết hạn sau 30 giây hoặc khi PID không còn sống.
- Không API nào trả `accessToken`/`refreshToken`. `POST /api/accounts/*` bắt buộc header `X-Token-Tracker: 1`, `Origin` (nếu có) ∈ `http://127.0.0.1:<PORT>`, `http://localhost:<PORT>`, địa chỉ nguồn loopback; sai → 403.
- `TT_SKIP_PROCESS_CHECK=1` → `switchTo` mặc định dùng `processes: () => ({ ok: true, list: [] })` (chỉ cho test CLI/API).
- Ngưỡng: `alertLimitPct` mặc định 90 (0 = tắt); hạn đăng nhập "soon" khi còn < 3 ngày.
- Chữ hiển thị tiếng Việt, theo giọng các chuỗi hiện có.
- Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Ứng dụng Claude desktop** (`C:\Program Files\WindowsApps\Claude_…\app\Claude.exe`, cũng tên `claude.exe`) không được tính là phiên Claude Code; bản VS Code (`…\anthropic.claude-code-…\native-binary\claude.exe`) và CLI thì có → test ở Task 2 dùng đúng các command line thật này.
2. **Sau `/logout`** (không có `claudeAiOauth`): `sync` không làm gì, không tạo hồ sơ rỗng, không báo conflict; `switchTo` vẫn đổi được sang hồ sơ đã lưu → test ở Task 3 và Task 2.
3. **Máy không có `.credentials.json`** (người dùng API key, hoặc lần đầu cài): tracker và dashboard chạy bình thường, thẻ Tài khoản hiện "Chưa có tài khoản", không lỗi 500 → test ở Task 6.
4. **Tên mơ hồ**: `cc-switch cam` khi có `cam` và `cam2` → khớp chính xác thắng tiền tố; `cc-switch ca` → mã thoát 2 "mơ hồ" → test ở Task 1.
5. **Dòng thời gian không theo thứ tự**: "Giữ F" chèn mục với `t = conflict.since` có thể nhỏ hơn mục cuối → `entries` luôn được giữ sắp xếp tăng dần theo `t` để `accountAt` đúng → test ở Task 3.

---

## Cấu trúc file

| File | Trách nhiệm |
|---|---|
| `accounts.js` (mới) | Đọc/kiểm tra/ghi file đăng nhập, hồ sơ, khoá, sao lưu, dòng thời gian, tìm tiến trình, `switchTo`, `sync`, `keep`, CLI (`require.main === module`). |
| `cc-switch.cmd` (mới) | `@node "%~dp0accounts.js" %*` |
| `analytics.js` | + `accountAt`, `effectiveUsage`, `loginState`, `suggestAccount`. |
| `tracker.js` | Export hàm, chạy lệnh chỉ khi `require.main === module`; `sync` trong `scan`; cột `account`; `daily` theo tài khoản + model; API tài khoản + bảo mật; cảnh báo mới. |
| `dashboard.html` | Thẻ Tài khoản, băng conflict, bộ lọc tài khoản, vạch mốc đổi, ô cài đặt `alertLimitPct`. |
| `tray.ps1` | Menu con Tài khoản, tooltip có tên, icon warn khi conflict/expired. |
| `test/helpers.js` (mới) | Tạo thư mục Claude giả + dữ liệu mẫu. |
| `test/accounts.test.js`, `test/analytics.test.js`, `test/tracker.test.js`, `test/cli.test.js` (mới) | Test. |
| `README.md` | Mục "Nhiều tài khoản". |

---

### Task 1: Nền tảng `accounts.js` — đường dẫn, đọc/kiểm tra, hồ sơ, ghi atomic, sao lưu, khoá

**Files:**
- Create: `accounts.js`, `test/helpers.js`, `test/accounts.test.js`

**Interfaces:**
- Produces (export từ `accounts.js`):
  - `paths() -> { claudeDir, credFile, claudeJson, profilesDir, backupDir, lockFile, logFile }` (`logFile` = `<dataDir>/account-log.json`)
  - `class AccountError extends Error { code }` với `code ∈ 'FORMAT' | 'NOT_FOUND' | 'AMBIGUOUS' | 'LOCKED' | 'NO_TOKEN' | 'WRITE_FAILED' | 'ACTIVE'`
  - `readLogin() -> { cred, cfg, id, org }` — `id = null` khi không có `cred.claudeAiOauth` hoặc file không tồn tại (cred = `{}`); ném `AccountError('FORMAT')` khi JSON hỏng, khi có `claudeAiOauth` mà thiếu `accessToken`/`refreshToken` (string), khi thiếu `cfg.oauthAccount.accountUuid`, hoặc khi `cfg.oauthAccount.organizationUuid` khác `cred.organizationUuid` (cả hai cùng có).
  - Hồ sơ: `{ v: 1, id, name, email, plan, oauth, organizationUuid, oauthAccount, usage, savedAt }`
  - `profileFromLogin(login, existing?, now) -> Profile` — giữ `name` của `existing`; `plan = oauth.subscriptionType || ''`; `usage = cfg.cachedUsageUtilization` nếu `.accountUuid === id`, ngược lại giữ `existing.usage` (hoặc `null`).
  - `listProfiles() -> Array<Profile | { id, error }>`, `loadProfile(id) -> Profile | null`, `saveProfile(p)`, `deleteProfile(id)`
  - `uniqueName(base, profiles) -> string` — `base` rồi `base2`, `base3`…
  - `resolve(query, profiles) -> Profile` — thứ tự: `id` khớp → `name` khớp (không phân biệt hoa thường) → `email` khớp → tiền tố duy nhất của `name`/`email`; nhiều kết quả → `AMBIGUOUS`; không có → `NOT_FOUND`.
  - `writeLogin(profile)` — đọc lại hai file ngay trước khi ghi, thay đúng các trường, ghi atomic theo định dạng của từng file.
  - `backup(now) -> string` (đường dẫn prefix) — chép hai file vào `backupDir/<now>-credentials.json` / `<now>-claude.json`, xoá các cặp cũ hơn 5 cặp gần nhất; `restore(prefix)`.
  - `withLock(fn, now?) -> ReturnType<fn>` — ném `LOCKED` nếu khoá còn hiệu lực; luôn thả khoá trong `finally`. `isLocked(now?) -> boolean`.
  - `publicView(p) -> { id, name, email, plan, usage, loginExpiresAt, savedAt, error? }` — `loginExpiresAt = oauth?.refreshTokenExpiresAt ?? null`.
- Produces (`test/helpers.js`): `makeEnv() -> { dir, dataDir, cleanup }` (đặt `CLAUDE_CONFIG_DIR`, `TT_DATA_DIR` vào thư mục tạm), `fakeAccount(n) -> { id, org, email, oauth, oauthAccount }` (id `acc-n`, org `org-n`, email `user<n>@example.com`, token `at-n`/`rt-n`), `writeLoginFiles(dir, acc, extras?)` (credentials có thêm `mcpOAuth: { x: { accessToken: 'mcp' } }`; `.claude.json` có `projects: { p: 1 }`, `numStartups: 7`, và `cachedUsageUtilization` cho acc nếu `extras.usage`).

- [ ] **Step 1: Viết test thất bại** trong `test/accounts.test.js`:
  - `readLogin` trả `id: 'acc-1'`, `org: 'org-1'` với file mẫu; trả `id: null` khi không có file; ném `code === 'FORMAT'` khi `claudeAiOauth.refreshToken` vắng và khi `oauthAccount.organizationUuid` lệch.
  - `writeLogin(profileOf(acc2))` trên file của acc1: sau đó `readLogin().id === 'acc-2'`, `cred.mcpOAuth` deep-equal bản gốc, `cfg.projects` và `cfg.numStartups` giữ nguyên; `.credentials.json` không chứa `\n`, `.claude.json` bắt đầu bằng `{\n  "`.
  - `backup` gọi 7 lần với `now` khác nhau → còn đúng 10 file trong `backupDir`; `restore(prefix)` trả lại nội dung cũ.
  - `withLock` lồng nhau → `LOCKED`; khoá có `t` cũ hơn 30 giây hoặc `pid: 999999` → bị coi là hết hạn.
  - `resolve`: hồ sơ `cam`, `cam2`, `work` → `resolve('cam')` là `cam`, `resolve('CAM2')` là `cam2`, `resolve('wo')` là `work`, `resolve('ca')` ném `AMBIGUOUS`, `resolve('zzz')` ném `NOT_FOUND`.
  - `uniqueName('cam', [{name:'cam'}]) === 'cam2'`; `uniqueName('cam', [{name:'cam'},{name:'cam2'}]) === 'cam3'`.
  - `JSON.stringify(publicView(p))` không chứa `at-1` hay `rt-1`.
- [ ] **Step 2: Chạy** `node --test test/accounts.test.js` → FAIL (`Cannot find module '../accounts.js'`).
- [ ] **Step 3: Viết các hàm trên trong `accounts.js`** (CommonJS, comment tiếng Việt theo phong cách `tracker.js`). Kiểm tra PID còn sống bằng `process.kill(pid, 0)` trong try/catch.
- [ ] **Step 4: Chạy** `node --test test/accounts.test.js` → PASS.
- [ ] **Step 5: Commit** `git add accounts.js test/ && git commit -m "feat(accounts): hồ sơ, đọc/ghi file đăng nhập, sao lưu, khoá"`

---

### Task 2: Dòng thời gian, tìm tiến trình, `switchTo`

**Files:**
- Modify: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `readLog() -> { v: 1, entries: Array<{ t, id, reason, running? }>, conflict: null | { fileId, chosenId, since } }` (file không có → rỗng)
  - `addEntry(log, entry)` — chèn và giữ `entries` sắp xếp tăng theo `t`; `writeLog(log)`.
  - `chosenId(log) -> string | null` — `id` của mục cuối.
  - `isClaudeCodeProcess({ name, path, cmd }) -> boolean`
  - `findClaudeProcesses() -> { ok: boolean, list: Array<{ pid, cmd }> }` — Windows: `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"` qua `execFileSync` (timeout 8s), lọc bằng `isClaudeCodeProcess`, loại `process.pid`; lỗi → `{ ok: false, list: [] }`; khác Windows → `ps -eo pid,args` lọc tương tự.
  - `snapshot(login, now) -> Profile | null` — lưu hồ sơ của `login.id` (null nếu `id` null).
  - `switchTo(query, { now = Date.now(), processes = findClaudeProcesses } = {}) -> { ok: true, from, to, already?: true, running: Array, checked: boolean }`

- [ ] **Step 1: Viết test thất bại:**
  - `isClaudeCodeProcess`: `true` với `{ name: 'claude.exe', path: 'c:\\Users\\cam\\.vscode\\extensions\\anthropic.claude-code-2.1.289-win32-x64\\resources\\native-binary\\claude.exe' }`, với `{ name: 'node.exe', cmd: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }`, với `{ name: 'claude.exe', path: 'C:\\Users\\cam\\.local\\bin\\claude.exe' }`; `false` với `{ name: 'claude.exe', path: 'C:\\Program Files\\WindowsApps\\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe' }` và với `node tracker.js serve`.
  - `addEntry` chèn `{t: 5}` vào `[{t:0},{t:10}]` → thứ tự `0, 5, 10`.
  - `switchTo('user2')` khi file là acc1 (đã có hồ sơ acc1 cũ với `rt-old`, file có `rt-1`): hồ sơ acc1 sau đó có `refreshToken === 'rt-1'`; file là acc2; mục cuối log `{ id: 'acc-2', reason: 'switch', running: 1 }` với `processes: () => ({ ok: true, list: [{ pid: 1 }] })`; kết quả `running.length === 1`, `checked === true`; có đúng 1 cặp sao lưu.
  - `switchTo` sang chính tài khoản đang ở → `already: true`, log không đổi.
  - `switchTo` khi hồ sơ đích không có `oauth` → `NO_TOKEN`, file không đổi.
  - Sau `/logout` (credentials không có `claudeAiOauth`, `.claude.json` không có `oauthAccount`) → `switchTo('user2')` thành công, file là acc2.
  - Giả lập ghi lỗi (`writeLogin` bị thay bằng hàm ném `EPERM` qua tuỳ chọn test `opts.write`) → ném `WRITE_FAILED`, hai file trùng bản trước khi đổi.
  - `switchTo` khi đang `conflict` → `conflict` thành `null`.
- [ ] **Step 2: Chạy** `node --test test/accounts.test.js` → các test mới FAIL.
- [ ] **Step 3: Viết hàm.** `switchTo` theo đúng các bước 1–10 ở mục 5.2 của spec trong `withLock`; kiểm tra lại sau khi ghi bằng `readLogin().id === target.id`, thử lại tối đa 3 lần cách 200ms (`Atomics.wait` trên `SharedArrayBuffer` để ngủ đồng bộ), vẫn sai → `restore` + `WRITE_FAILED`. Tham số ẩn `opts.write = writeLogin` chỉ để test.
- [ ] **Step 4: Chạy** `node --test test/accounts.test.js` → PASS.
- [ ] **Step 5: Kiểm tra thật (chỉ đọc):** `node -e "console.log(require('./accounts.js').findClaudeProcesses())"` → `ok: true`, danh sách chỉ gồm các PID `claude.exe` của VS Code, không có tiến trình `WindowsApps\Claude_…`.
- [ ] **Step 6: Commit** `git commit -am "feat(accounts): dòng thời gian, phát hiện phiên đang chạy, đổi tài khoản"` (nhớ `git add` test mới nếu có).

---

### Task 3: `sync` và `keep`

**Files:**
- Modify: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: Task 1–2.
- Produces:
  - `sync(now = Date.now()) -> { skipped?: 'locked' | 'format' | 'nologin', added?: id, updated?: id, conflict?: { fileId, chosenId, since } }`
  - `keep(now = Date.now()) -> { ok: true, id }` — ném `NOT_FOUND` nếu không có conflict.

- [ ] **Step 1: Viết test thất bại:**
  - Lần đầu (không hồ sơ, không log), file là acc1 → tạo hồ sơ `name: 'user1'`, log `[{ t: 0, id: 'acc-1', reason: 'init' }]`, trả `added: 'acc-1'`.
  - Có log rồi, file đổi sang acc3 chưa có hồ sơ → hồ sơ acc3 được tạo, mục `{ t: now, id: 'acc-3', reason: 'login' }`.
  - File = tài khoản đang chọn, token đổi (`rt-1b`) → hồ sơ cập nhật, trả `updated`; token không đổi → không ghi file hồ sơ (so `savedAt` không đổi).
  - `cachedUsageUtilization.accountUuid === 'acc-1'` → `usage` lưu vào hồ sơ acc1; `accountUuid` khác → không lưu.
  - Đang chọn acc2, file là acc1 (đã có hồ sơ) → hồ sơ acc1 nhận token mới, `log.conflict = { fileId: 'acc-1', chosenId: 'acc-2', since: now }`; gọi `sync` lần nữa ở `now + 60000` → `since` giữ nguyên.
  - `keep(now2)` → mục `{ id: 'acc-1', reason: 'keep', t: since }` nằm đúng vị trí sắp xếp, `conflict === null`.
  - Không có `claudeAiOauth` → `skipped: 'nologin'`, không tạo hồ sơ, không conflict.
  - `isLocked()` đúng → `skipped: 'locked'`; file hỏng → `skipped: 'format'`.
- [ ] **Step 2: Chạy** → FAIL.
- [ ] **Step 3: Viết `sync`, `keep`** theo mục 5.3 của spec. So sánh "đã đổi" bằng `JSON.stringify` của `{ oauth, organizationUuid, oauthAccount, usage }`.
- [ ] **Step 4: Chạy** `node --test test/accounts.test.js` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(accounts): đồng bộ hồ sơ, phát hiện ghi đè, giữ tài khoản"`

---

### Task 4: Hàm thuần trong `analytics.js`

**Files:**
- Modify: `analytics.js` (thêm vào trước `return { … }` và vào object export)
- Create: `test/analytics.test.js`

**Interfaces:**
- Produces:
  - `accountAt(entries, t) -> string | null` — `entries` đã sắp xếp; tìm nhị phân mục cuối có `entry.t <= t`; không có → `entries[0]?.id ?? null`.
  - `effectiveUsage(usage, now) -> { fiveHour: { pct, resetsAt } | null, sevenDay: { pct, resetsAt } | null, fetchedAt: number | null }` — đọc `usage.utilization.five_hour` / `seven_day`; `resetsAt = Date.parse(resets_at)`; `resetsAt <= now` → `pct: 0`; thiếu → `null`; `usage` null → cả ba `null`.
  - `loginState(expiresAt, now) -> 'ok' | 'soon' | 'expired' | 'unknown'` — `null` → `'unknown'`; `<= now` → `'expired'`; `< now + 3 * DAY` → `'soon'`.
  - `suggestAccount(accounts, activeId, now) -> string | null` — `accounts: Array<{ id, usage, loginExpiresAt }>`; loại `activeId`, loại `loginState === 'expired'`, loại tài khoản không có dữ liệu usage nào; điểm = `max(fiveHour?.pct ?? 0, sevenDay?.pct ?? 0)`; nhỏ nhất thắng, hoà → `fiveHour.resetsAt` sớm hơn (thiếu coi là `Infinity`).

- [ ] **Step 1: Viết test thất bại** (`const A = require('../analytics.js')`):
  - `accountAt([{t:0,id:'a'},{t:100,id:'b'}], 50) === 'a'`, `(…, 100) === 'b'`, `(…, 999) === 'b'`; `accountAt([{t:10,id:'a'}], 5) === 'a'`; `accountAt([], 5) === null`.
  - `effectiveUsage` với `five_hour: { utilization: 18, resets_at: '2026-10-05T12:19:59.991143+00:00' }`: `now` trước mốc → `pct 18`, sau mốc → `pct 0`.
  - `loginState(null) === 'unknown'`, `(now - 1) === 'expired'`, `(now + 2 * DAY) === 'soon'`, `(now + 10 * DAY) === 'ok'`.
  - `suggestAccount`: active `a`; `b` 5h 20 tuần 50, `c` 5h 10 tuần 30, `d` hết hạn đăng nhập 0% → `'c'`; nếu `c` có cửa sổ tuần đã reset (pct 0) và 5h 40, `b` 5h 40 tuần 0, `b` reset 5h sớm hơn → `'b'`; chỉ còn `a` → `null`.
- [ ] **Step 2: Chạy** `node --test test/analytics.test.js` → FAIL.
- [ ] **Step 3: Viết bốn hàm, thêm vào export.**
- [ ] **Step 4: Chạy** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(analytics): gán tài khoản theo thời gian, hạn mức hiệu dụng, gợi ý"` (kèm `git add test/analytics.test.js`).

---

### Task 5: CLI `cc-switch`

**Files:**
- Modify: `accounts.js` (khối `if (require.main === module)` cuối file)
- Create: `cc-switch.cmd`, `test/cli.test.js`

**Interfaces:**
- Consumes: Task 1–4 (`effectiveUsage`, `loginState` từ `analytics.js` cho cột hiển thị).
- Produces: lệnh
  - `cc-switch` → bảng: `*` ở tài khoản đang chọn (`chosenId`), tên, email, gói, `5h 18%`, `tuần 76%` (hoặc `—`), hạn đăng nhập (`ok` → ngày; `soon` → "còn N ngày"; `expired` → "cần /login lại"). Chạy `sync()` trước khi in. Không có hồ sơ → "Chưa có tài khoản nào — /login trong Claude Code rồi chạy lại".
  - `cc-switch <query>` → `switchTo`; in "Đã đổi sang <tên> (<email>)"; `running.length > 0` → stderr "Cảnh báo: N phiên Claude Code đang chạy vẫn dùng tài khoản cũ cho tới khi khởi động lại"; `checked === false` → stderr "Không kiểm tra được phiên đang chạy".
  - `cc-switch rename <query> <tên mới>` (tên trùng hồ sơ khác → lỗi), `cc-switch remove <query>` (đang chọn → `ACTIVE`), `cc-switch keep`.
  - Mã thoát: 0 ok; 2 với `NOT_FOUND`/`AMBIGUOUS`; 1 lỗi khác; thông báo lỗi tiếng Việt theo `code`.
  - `cc-switch.cmd`: `@node "%~dp0accounts.js" %*`

- [ ] **Step 1: Viết test thất bại** chạy `spawnSync(process.execPath, ['accounts.js', …], { env: { ...process.env, CLAUDE_CONFIG_DIR, TT_DATA_DIR } })` (env test đặt thêm `TT_SKIP_PROCESS_CHECK=1` để `switchTo` dùng `processes: () => ({ ok: true, list: [] })`):
  - không tham số với hai hồ sơ → stdout có `user1`, `user2` và đúng một dòng bắt đầu bằng `*`.
  - `user2` → exit 0, file là acc2; `user` (tiền tố của cả hai) → exit 2; `zzz` → exit 2.
  - `rename user2 work` → `resolve('work')` thành công; `remove work` khi đang chọn → exit 1.
- [ ] **Step 2: Chạy** `node --test test/cli.test.js` → FAIL.
- [ ] **Step 3: Viết CLI + `cc-switch.cmd`.**
- [ ] **Step 4: Chạy** `node --test test/` → PASS toàn bộ.
- [ ] **Step 5: Kiểm tra thật (chỉ đọc):** `node accounts.js` trên máy thật → tạo hồ sơ cho tài khoản hiện tại, in một dòng `*` đúng email; kiểm tra `~/.claude/.credentials.json` không đổi (so `mtime` trước/sau).
- [ ] **Step 6: Commit** `git add accounts.js cc-switch.cmd test/cli.test.js && git commit -m "feat: lệnh cc-switch"`

---

### Task 6: Tracker — gán tài khoản, lịch sử theo tài khoản, API, bảo mật, cảnh báo

**Files:**
- Modify: `tracker.js` (đầu file: `DATA_DIR`; `STORE_VERSION`; `DEFAULT_CONFIG`; `toRow`/`ROW_COLS`/`INDEXED`/`records`; `addDaily`/`backfill`/`scan`; `checkAlerts`; `/api/summary`; `serve`; cuối file)
- Create: `test/tracker.test.js`

**Interfaces:**
- Consumes: `accounts.sync`, `readLog`, `chosenId`, `listProfiles`, `publicView`, `switchTo`, `keep`, `withLock`, `resolve`, `saveProfile`, `uniqueName`; `A.accountAt`, `A.effectiveUsage`, `A.loginState`, `A.suggestAccount`.
- Produces:
  - `module.exports = { scan, analyze, records, accountsInfo, checkAlerts, createServer }`; lệnh CLI chỉ chạy khi `require.main === module`; `serve()` dùng `createServer()`.
  - `DATA_DIR = process.env.TT_DATA_DIR || path.join(__dirname, 'data')`; `STORE_VERSION = 5`; `DEFAULT_CONFIG.alertLimitPct = 90`.
  - Hàng có thêm cột `account` (trong `ROW_COLS` sau `effort`, và trong `INDEXED`); `toRow(r, entries)` đặt `account: A.accountAt(entries, r.t) || ''`.
  - `daily[day]` khoá `${account}|${model}${fast ? '|fast' : ''}`.
  - `accountsInfo(rows, now) -> { active, fileAccount, conflict, accounts: Array<publicView & { usage: effectiveUsage, loginState, costToday, costWeek, suggested: boolean, error? }> }` — `costToday`/`costWeek` cộng `r.c.total` theo `r.account` từ `startOfDay`/`startOfWeek`.
  - `records()` thêm `accounts: accountsInfo(...)`, `accountLog: readLog().entries`.
  - Cửa sổ 5h ước lượng (`/api/summary`, `statusLine`, cảnh báo burn) dùng `rows.filter(r => r.account === active)` khi có `active`; ngân sách dùng toàn bộ `rows`.
  - API: `GET /api/accounts` → `accountsInfo`; `POST /api/accounts/switch {id}`, `POST /api/accounts/keep`, `POST /api/accounts/rename {id, name}`; lỗi `AccountError` → 400 `{ error: code, message }`; `/api/summary` thêm `account: { name, fiveHour, sevenDay } | null`, `conflict: boolean`, `needLogin: string[]` (tên các hồ sơ `expired`).
  - `guardPost(req) -> boolean` theo Global Constraints.
  - Cảnh báo mới trong `checkAlerts` (dùng `push` sẵn có): conflict `conflict:${since}` (warning, "Đăng nhập hiện là {F} nhưng bạn đang chọn {I}", thân "Phiên cũ ghi đè hoặc vừa /login — mở dashboard để xử lý"); tài khoản mới `newacct:${id}:${t}` cho mục `reason: 'login'` trong 10 phút qua (info); hạn mức `limit:${id}:${win}:${resetsAt}` khi `pct >= alertLimitPct` (warning, "{tên} đã dùng 92% cửa sổ 5h", thân "Gợi ý: {B} (đang 20%, cập nhật 3 giờ trước)" hoặc "Không có tài khoản khác còn hạn mức"); đăng nhập `login:${id}:${state}:${expiresAt}` cho `soon` (warning) / `expired` (critical, "{tên}: cần /login lại").

- [ ] **Step 1: Viết test thất bại** trong `test/tracker.test.js` (đặt `CLAUDE_CONFIG_DIR`, `TT_DATA_DIR`, `CLAUDE_PROJECTS_DIR` vào thư mục tạm **trước** `require('../tracker.js')`; viết 1 file `.jsonl` mẫu có 3 lượt assistant ở `t0`, `t0+1h`, `t0+3h`; log tài khoản `[{t:0,id:'acc-1'},{t:t0+2h,id:'acc-2'}]`):
  - `records()` → cột `account` của 3 lượt là `acc-1, acc-1, acc-2`; `daily` có khoá bắt đầu `acc-1|` và `acc-2|`.
  - `accountsInfo` → `costToday` của acc1 + acc2 = tổng; `JSON.stringify` không chứa `at-` hay `rt-`.
  - Không có `.credentials.json` và không có hồ sơ → `records()` chạy được, `accounts.accounts` rỗng, `active === null`.
  - Server (`createServer().listen(0)`): `GET /api/accounts` 200; `POST /api/accounts/switch` thiếu header → 403; có header + `Origin: http://evil.example` → 403; có header, không `Origin` → 200 và file là acc2; `id` lạ → 400 `NOT_FOUND`.
  - `checkAlerts` với `alertLimitPct: 90` và usage acc1 5h 92% (resets_at tương lai), `notify: false` → `alerts.json` có mục tiêu đề chứa "92%" và "Gợi ý" trỏ acc2; gọi lại → không thêm mục trùng.
- [ ] **Step 2: Chạy** `node --test test/tracker.test.js` → FAIL.
- [ ] **Step 3: Sửa `tracker.js`** theo Interfaces. Gọi `accounts.sync(now)` ở đầu `scan()` trong try/catch (lỗi → `console.error`, quét log vẫn chạy). Truyền `readLog().entries` vào `toRow`/`addDaily`/`backfill`.
- [ ] **Step 4: Chạy** `node --test test/` → PASS toàn bộ.
- [ ] **Step 5: Kiểm tra thật:** `node tracker.js report` chạy không lỗi; `node tracker.js serve` rồi `curl -s http://127.0.0.1:7788/api/accounts` → có tài khoản thật, không có chuỗi `Token`; `curl -s -X POST http://127.0.0.1:7788/api/accounts/switch -d '{}'` → 403.
- [ ] **Step 6: Commit** `git add tracker.js test/tracker.test.js && git commit -m "feat(tracker): số liệu, API và cảnh báo theo tài khoản"`

---

### Task 7: Dashboard

**Files:**
- Modify: `dashboard.html` — HTML: thêm thẻ Tài khoản sau `#banner` (dòng ~393), ô `alertLimitPct` trong `#cfgForm` (dòng ~423), nút lọc trong header cạnh `#rangeSeg`; JS: `ingest` (~746), `compute` (~766, lọc `ROWS`), `renderHistory` (~1512, tách khoá 3 phần), `renderBars`/`renderHistory` (vạch mốc đổi), `renderAll` (~1629), xuất CSV (~1671 thêm cột Tài khoản).

**Interfaces:**
- Consumes: `records()` từ Task 6 (`accounts`, `accountLog`, cột `account`); `POST /api/accounts/switch|keep|rename` với header `X-Token-Tracker: 1`.
- Produces: `renderAccounts()`, `renderConflict()`, biến `ACCOUNT` (`'all'` hoặc id, nhớ trong `localStorage` bọc try/catch), `accountName(id)`.

- [ ] **Step 1: Thẻ "Tài khoản"** — bảng mỗi hồ sơ: tên (bấm để đổi tên tại chỗ → `rename`), email, gói, thanh % 5h và % tuần (dùng các token màu sẵn có: < 70% màu thường, ≥ 70% `warn`, ≥ `alertLimitPct` `bad`), "reset HH:mm" và "cập nhật N phút trước", chi phí hôm nay/tuần, hạn đăng nhập (`soon` vàng, `expired` đỏ "cần /login lại"), nhãn "Đang dùng" / "Gợi ý", nút **Đổi** (ẩn ở tài khoản đang dùng). Đổi xong: hiện kết quả (`running.length` > 0 → "N phiên đang chạy vẫn dùng tài khoản cũ cho tới khi khởi động lại") rồi `load()`. Không có hồ sơ → "Chưa có tài khoản — /login trong Claude Code, tài khoản sẽ tự xuất hiện". Hồ sơ có `error` → một dòng đỏ "Hồ sơ {id} bị hỏng" không có nút Đổi.
- [ ] **Step 2: Băng conflict** (`accounts.conflict`) với nút **Áp lại {I}** (`switch` chosenId) / **Giữ {F}** (`keep`).
- [ ] **Step 3: Bộ lọc tài khoản** `Tất cả | <tên>…` (ẩn khi < 2 hồ sơ); `ingest` lưu `ALL_ROWS`, `ROWS = ACCOUNT === 'all' ? ALL_ROWS : ALL_ROWS.filter(r => r.account === ACCOUNT)`; `SUM` tính trên `ROWS`. `renderHistory` tách `const [account, model, fast] = key.split('|')` và bỏ qua khoá không thuộc `ACCOUNT`.
- [ ] **Step 4: Vạch mốc đổi** — trên `#bars` và `#histChart`, vẽ đường dọc nét đứt (`class: 'gl'` + `stroke-dasharray`) tại mỗi `accountLog` entry (trừ `t: 0`) nằm trong khoảng hiển thị; tooltip "Đổi sang {tên}" và nếu `running > 0` thêm "· N phiên đang chạy lúc đổi — số liệu sau mốc này có thể bị tính sai tài khoản".
- [ ] **Step 5: Ô cài đặt** "Báo khi hạn mức tài khoản đạt (%)" `name="alertLimitPct"` min 0 max 100.
- [ ] **Step 6: Kiểm tra trong trình duyệt:** chạy `node tracker.js serve`, mở http://127.0.0.1:7788 (skill `run` hoặc trình duyệt): thẻ Tài khoản hiện tài khoản thật với % khớp `cc-switch`; không lỗi trong console; giao diện sáng và tối đều đọc được; ở khổ 390px không cuộn ngang.
- [ ] **Step 7: Commit** `git commit -am "feat(dashboard): thẻ tài khoản, bộ lọc, mốc đổi, xử lý ghi đè"`

---

### Task 8: Khay

**Files:**
- Modify: `tray.ps1` (menu dòng 68–78, `Update-Status` dòng 82–110)

**Interfaces:**
- Consumes: `GET /api/accounts`, `POST /api/accounts/switch` (header `X-Token-Tracker: 1`, body `{"id": …}`, `-ContentType 'application/json; charset=utf-8'`), `/api/summary` (`account`, `conflict`, `needLogin`).

- [ ] **Step 1:** Thêm `ToolStripMenuItem` "Tài khoản" sau dòng tóm tắt; trong `Update-Status`, dựng lại `DropDownItems`: mỗi hồ sơ một dòng `Tên · 5h 42% · tuần 76%` (thêm `· cần /login` khi `loginState = 'expired'`), `Checked = $true` ở tài khoản đang dùng; click → POST switch → `$tray.ShowBalloonTip(5000, 'Đã đổi tài khoản', <tên + cảnh báo N phiên đang chạy nếu có>, 'Info')`, lỗi → balloon `'Error'` với `message`; sau đó `Update-Status`. Không có hồ sơ → một dòng mờ "Chưa có tài khoản".
- [ ] **Step 2:** Dòng tóm tắt và tooltip thêm tên tài khoản đầu dòng (`$s.account.name`), vẫn cắt tooltip ở 63 ký tự; `conflict` hoặc `needLogin` khác rỗng → nâng `$state` lên `warn` nếu đang là `idle`/`good`.
- [ ] **Step 3: Kiểm tra tay:** tắt khay cũ (chuột phải → Thoát), chạy `powershell -ExecutionPolicy Bypass -File tray.ps1`; menu "Tài khoản ▸" có dấu ✓ đúng tài khoản; tooltip có tên.
- [ ] **Step 4: Commit** `git commit -am "feat(tray): menu đổi tài khoản"`

---

### Task 9: README và kiểm tra cuối với tài khoản thật

**Files:**
- Modify: `README.md` (thêm mục "## Nhiều tài khoản" sau "## Cảnh báo"; thêm `accounts.js`, `cc-switch.cmd`, `data/account-log.json`, `~/.claude/account-profiles/` vào bảng File)

- [ ] **Step 1: Viết mục README:** cách thêm tài khoản (`/login` → tự xuất hiện, đổi tên trên dashboard hoặc `cc-switch rename`); cách đổi (khay / dashboard / `cc-switch <tên>`; thêm thư mục dự án vào PATH để dùng `cc-switch`); cảnh báo đổi khi còn phiên chạy và cách xử lý băng "Áp lại / Giữ"; % hạn mức lấy từ cache của Claude Code nên tài khoản không dùng chỉ cập nhật tới lần dùng cuối; hồ sơ chứa token, nằm cạnh `.credentials.json`, đừng chia sẻ thư mục `account-profiles`; khôi phục bằng tay từ `account-profiles/backup/`.
- [ ] **Step 2: Chạy toàn bộ test** `node --test test/` → PASS.
- [ ] **Step 3: Kiểm tra tay với 2 tài khoản thật** (người dùng thực hiện, mình hướng dẫn): `/login` tài khoản thứ hai → dashboard tự hiện; `cc-switch <tk1>` → `/status` trong terminal mới và trong VS Code (sau khi mở lại phiên) hiện đúng email; đổi khi còn một phiên cũ mở → cảnh báo; nếu phiên cũ ghi đè → băng conflict, bấm "Áp lại" về đúng tài khoản; `/login` vẫn không bị hỏi lại sau nhiều lần đổi qua lại trong 1 ngày.
- [ ] **Step 4: Commit** `git commit -am "docs: hướng dẫn nhiều tài khoản"`
