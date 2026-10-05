# CC Remote Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub trên VPS trung chuyển giữa app iOS và PC qua giao thức WebSocket riêng, nhiều người dùng tách biệt, đăng nhập không hết hạn, tin lớn + ảnh, thông báo ntfy do hub gửi.

**Architecture:** `hub/` (Node, `ws`, `node:sqlite`) xác thực và định tuyến theo `userId`; PC chạy `hub-link.js` kết nối ra hub và gọi lõi `remote.js` qua một hàm `call(method, params, ctx)` dùng chung với HTTP cũ; app iOS thêm `HubClient`. Đường Tailscale cũ chạy song song.

**Tech Stack:** Node 24 (`node:test`, `node:sqlite`, `crypto.scrypt`, WebSocket client có sẵn), `ws` (chỉ ở hub), Caddy, systemd, SwiftUI (`URLSessionWebSocketTask`, PhotosPicker).

**Spec:** `docs/superpowers/specs/2026-10-05-cc-remote-hub-design.md`

## Global Constraints

- Agent (tracker/remote/hub-link) không thêm thư viện ngoài; hub chỉ thêm `ws` (`hub/package.json`).
- Node ≥ 22.13 (`node:sqlite` không cần cờ); VPS cài Node 24.
- `proto: 1`. Endpoint WS: `/v1/ws`. Hub nghe `127.0.0.1:7790` (env `HUB_PORT`, `HUB_HOST`, `HUB_DATA`).
- Token thiết bị / máy: 32 byte ngẫu nhiên base64url, DB lưu SHA-256 hex; **không hết hạn**.
- Mật khẩu: scrypt, muối 16 byte, N=2^15, r=8, p=1, keylen 32; tối thiểu 8 ký tự. Tên đăng nhập `^[a-z0-9_.-]{3,32}$`, đưa về chữ thường.
- Sai mật khẩu 5 lần / 15 phút theo (tên, IP) → khoá 15 phút. Mã mời: 24 giờ, dùng một lần.
- RPC timeout 30 s; ping 20 s, rớt sau 60 s im; nối lại 1→30 s có nhiễu; `hello` phải đến trong 10 s.
- Khung WS ≤ 1 MB; tin JSON > 256 KB chia mảnh 256 KB; một tin ≤ 50 MB; ≤ 4 tin lớn đang truyền / kết nối; mảnh im 60 s → bỏ.
- Tin chữ ≤ 1 000 000 ký tự; ≤ 10 ảnh / tin; mime `image/jpeg|png|gif|webp`.
- Notify: bỏ trùng `key` trong 24 giờ; ≤ 30 / giờ / người; chỉ đẩy khi không app nào `foreground`.
- Lỗi trả `{error: CODE, message}` (message tiếng Việt). Sai tên hay sai mật khẩu đều là `BAD_LOGIN`; máy không thuộc mình hay không tồn tại đều là `NOT_FOUND`.
- Không SSH / không push trong phiên thực thi này (chờ người dùng xác nhận trực tiếp).

## Review Focus

- Agent rớt rồi nối lại khi app đang xem phiên: app nhận phần thiếu, không lặp (test ở Task 6).
- Hai app của cùng người: duyệt quyền ở một app, app kia thấy `decided` (Task 6).
- Hub khởi động lại: mọi agent / app tự nối lại và `sub` lại (Task 6).
- Token máy bị thu hồi khi đang kết nối: agent dừng nối lại, dashboard hiện "Đã bị ngắt khỏi hub" (Task 6, 7).
- App gửi tin lớn tới máy offline / không thuộc mình: hub trả `NOT_FOUND` ở mảnh đầu, không đệm phần còn lại (Task 4).

## File Structure

- `hub/package.json` — `{ "private": true, "dependencies": { "ws": "^8" } }`
- `hub/db.js` — mở SQLite, tạo bảng, truy vấn có `user_id`.
- `hub/auth.js` — băm mật khẩu, token, mã mời, khoá sai mật khẩu.
- `hub/proto.js` — mã hoá / giải mã khung `part`, bộ ghép mảnh. **Dùng chung** cho hub, `hub-link.js`, test.
- `hub/router.js` — kết nối, `hello`, định tuyến req/res/sub/event, cách ly, hàm của hub, presence.
- `hub/notify.js` — chống trùng, trần / giờ, gửi ntfy.
- `hub/hub.js` — HTTP (auth, pair, health) + WS server + CLI.
- `hub/deploy/{setup.sh,Caddyfile,cc-hub.service,backup.sh}`
- `hub-link.js` — phía PC: kết nối hub, chuyển req → `remote.call`, người xem qua hub, notify.
- `remote.js` — thêm `call()`, ảnh trong `send`, `sessions.image`, dọn `data/uploads`.
- `tracker.js`, `dashboard.html` — ghép / ngắt hub, trạng thái.
- `ios/CCRemote/*` — `HubClient.swift`, `LoginView.swift`, chọn máy, ảnh.
- Test: `test/hub.test.js`, `test/hub-link.test.js`, mở rộng `test/remote.test.js`, `test/tracker.test.js`.

---

### Task 1: Hub DB + xác thực

**Files:** Create `hub/package.json`, `hub/db.js`, `hub/auth.js`; Test `test/hub.test.js`

**Interfaces — Produces:**
- `openDb(file) -> Db` với: `createUser({username, passHash, admin}) -> user`, `userByName(name)`, `userById(id)`, `setLocked(id, bool)`, `deleteUser(id)`, `setPassword(id, hash)`, `addInvite(codeHash, createdBy, expiresAt)`, `useInvite(codeHash, userId, now) -> bool`, `addDevice(userId, name, tokenHash) -> {id}`, `deviceByToken(hash) -> {id, user_id, name}`, `devices(userId)`, `revokeDevice(userId, id) -> bool`, `revokeAllDevices(userId)`, `addMachine(...)`, `machineByToken(hash)`, `machines(userId)`, `renameMachine(userId, id, name) -> bool`, `revokeMachine(userId, id) -> bool`, `touch(table, id, now)`, `ntfyTopic(userId) -> string` (tạo nếu chưa có, 16 byte hex), `audit(userId, ip, event, detail)`, `users()`.
- `auth.hashPassword(pw) -> Promise<string>` (dạng `scrypt$N$salt$hash`), `auth.verifyPassword(pw, stored) -> Promise<bool>`, `auth.newToken() -> {token, hash}`, `auth.sha(s)`, `auth.normUser(name) -> string|null`, `auth.Limiter` với `blocked(key, now)`, `fail(key, now)`, `ok(key)`.

- [ ] **Step 1:** Test `hub: tài khoản, mã mời, token, khoá sai mật khẩu` — mã mời dùng một lần & hết hạn sau 24 h; `verifyPassword` đúng/sai; `normUser('Cam')==='cam'`, `normUser('a')===null`; `Limiter` khoá sau 5 lần trong 15 phút, mở sau 15 phút; `revokeMachine(otherUser, id)===false`; token lưu dạng băm (`deviceByToken(sha(token))`).
- [ ] **Step 2:** Chạy `node --test test/hub.test.js` → FAIL (module chưa có).
- [ ] **Step 3:** Viết `db.js`, `auth.js`; `npm install` trong `hub/`.
- [ ] **Step 4:** Test PASS.
- [ ] **Step 5:** Commit `feat(hub): DB và xác thực`.

### Task 2: Khung `part` và ghép mảnh

**Files:** Create `hub/proto.js`; Test `test/hub.test.js`

**Interfaces — Produces:** `PROTO = 1`, `CHUNK = 256*1024`, `MAX_MSG = 50*1024*1024`; `encodePart(header, payload: Buffer) -> Buffer`; `decodePart(buf) -> {header, payload}`; `splitMessage(obj, {to?, machine?}) -> Buffer[] | null` (null nếu JSON ≤ 256 KB); `class Assembler { push(header, payload, now) -> obj|null; sweep(now) }` (ném `TOO_LARGE` khi vượt 50 MB, `TOO_MANY` khi > 4 `pid` dở).

- [ ] **Step 1:** Test `proto: chia và ghép tin 5 MB; tin 51 MB bị huỷ; mảnh dở quá 60 s bị bỏ; header mang machine/to ở mọi mảnh`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(hub): chia mảnh tin lớn`.

### Task 3: Hub server — HTTP, CLI, router, cách ly

**Files:** Create `hub/router.js`, `hub/hub.js`; Test `test/hub.test.js`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces: `createHubServer({dataDir, now?, ntfyFetch?}) -> {server: http.Server, db, router, close()}`; CLI `node hub/hub.js init|invite|users|lock <u>|unlock <u>|delete <u>|serve`.
- Router: mỗi kết nối `{id, role, userId, deviceId|machineId, subs:Set<'machine:session'>, foreground}`. `req` từ app → nếu `machine==='hub'` gọi hàm hub, ngược lại tìm agent `machine` thuộc `userId` (không có → `NOT_FOUND`), gửi `{...req, conn}`; chờ `res` ≤ 30 s. `sub/unsub` cập nhật `subs` rồi chuyển cho agent kèm `conn`. Agent `event` → `to` (kiểm tra cùng user) hoặc mọi app có `subs` khớp, hoặc `scope:'user'` → mọi app. Agent vào/ra → `machine` tới mọi app cùng user. Mảnh `part`: mảnh `idx 0` được kiểm tra đích như tin thường, các mảnh sau theo đích đã chốt của `pid`.
- Hàm hub: `devices`, `devices.revoke {id}`, `logoutAll`, `machines`, `machines.rename {id,name}`, `machines.revoke {id}`, `password {old,new}`, `ntfy` → `{topic, url:'https://ntfy.sh/'+topic, subscribe:'ntfy://ntfy.sh/'+topic}`.
- Thu hồi / khoá → đóng kết nối liên quan với mã 4001 (`REVOKED`); agent thấy 4001 thì không nối lại.

- [ ] **Step 1:** Tests:
  - `hub HTTP: register bằng mã mời, login, logout, pair máy, health` (sai mật khẩu và sai tên cùng `BAD_LOGIN`; 6 lần sai → `LOCKED`).
  - `hub WS: hello sai token đóng 4001; proto lệch → UPGRADE_APP`.
  - `hub định tuyến: req/res, timeout 30 s (đồng hồ giả), sub → event chỉ tới app đã sub, scope user tới mọi app`.
  - `hub cách ly: B gửi req tới machine của A → NOT_FOUND; agent B gửi res/event{to: conn của A} → A không nhận; part của B trỏ machine A → NOT_FOUND`.
  - `hub thu hồi: revoke thiết bị đóng kết nối app đó; khoá user đóng mọi kết nối`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(hub): server, định tuyến và cách ly người dùng`.

### Task 4: `remote.call` — tách lõi khỏi HTTP

**Files:** Modify `remote.js` (khối định tuyến trong `createRemoteServer`); Test `test/remote.test.js`

**Interfaces — Produces:** `call(hub, method, params, ctx) -> Promise<any>` với các `method` ở spec §4.2 (+ `sessions.image`); ném `RemoteError`. `createRemoteServer` đổi sang gọi `call` (đường dẫn HTTP cũ giữ nguyên). `Session.send(text, images?)`.

- [ ] **Step 1:** Test `call: state, sessions.create/send/permission/interrupt/close qua call cho kết quả như HTTP; method lạ → NOT_FOUND`.
- [ ] **Step 2–4:** FAIL → viết → PASS; toàn bộ test cũ của remote vẫn PASS.
- [ ] **Step 5:** Commit `refactor(remote): call() dùng chung cho HTTP và hub`.

### Task 5: Ảnh và tin lớn trong phiên

**Files:** Modify `remote.js`; Test `test/remote.test.js`, `test/fake-claude.js`

**Interfaces — Produces:** `Session.send(text, images=[])` với `images: [{mime, data, name, thumb?}]`; phiên `claude -p` gửi `content: [{type:'text'}, …{type:'image', source:{type:'base64', media_type, data}}]`; phiên hook lưu `data/uploads/<sid>/<ts>-<n>.<ext>` và nối vào tin: `\n\n[Ảnh đính kèm — dùng tool Read để xem]\n<đường dẫn>`; sự kiện `user` thêm `images:[{name, thumb}]`; `sessions.image {id, name}` → `{mime, data}`; `sweep` xoá thư mục con của `data/uploads` cũ hơn 7 ngày. Trần chữ 1 000 000. Kiểm tra chữ ký file (`FFD8FF`, `89504E47`, `47494638`, `52494646…57454250`) → sai là `BAD_IMAGE`. (Ảnh nhỏ `thumb` do app tạo — PC không có thư viện ảnh.)

- [ ] **Step 1:** Tests: `ảnh vào phiên claude -p thành khối image` (fake-claude ghi lại stdin), `ảnh vào phiên VS Code thành file + đường dẫn trong tin hook`, `mime giả → BAD_IMAGE`, `11 ảnh → TOO_MANY_IMAGES`, `tin 900 000 ký tự qua được`, `uploads cũ 8 ngày bị dọn`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(remote): gửi ảnh và tin lớn`.

### Task 6: `hub-link.js` — PC nối hub

**Files:** Create `hub-link.js`; Test `test/hub-link.test.js` (hub thật trong tiến trình + `remote` hub giả `fake-claude`)

**Interfaces:**
- Consumes: `remote.call`, `Session.clients` (`{send(ev), reset()}`), Task 2, Task 3.
- Produces: `startLink({hubUrl, machineToken, hub, onStatus?}) -> {status() -> {state:'off'|'connecting'|'online'|'revoked', since, error?}, notify(n), stop()}`. `req` → `call` → `res`; `sub` → thêm client `{send: ev => event{to? , session, data}, reset}` (phát lại `after`/`epoch` cho riêng `conn`, sau đó sự kiện sống gửi không `to`); `unsub`/app rời → bỏ client. Mỗi `broadcastState` của phiên bất kỳ → `event{scope:'user', data:{kind:'sessions'}}` gộp 500 ms. Đóng 4001 → `revoked`, không nối lại.

- [ ] **Step 1:** Tests: `link: app gọi state qua hub`, `link: sub nhận phát lại rồi sự kiện sống`, `link: agent rớt & nối lại, app sub lại không mất/không lặp`, `link: hub khởi động lại, cả hai tự nối lại`, `link: hai app — duyệt quyền ở app 1, app 2 nhận decided`, `link: thu hồi máy → revoked, không nối lại`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(agent): hub-link kết nối PC với hub`.

### Task 7: Tracker + dashboard: ghép / ngắt hub

**Files:** Modify `tracker.js`, `remote.js` (`start()` nhận link), `dashboard.html`; Test `test/tracker.test.js`

**Interfaces — Produces:** `data/hub.json = {hubUrl, machineId, machineToken, name}`; `GET /api/hub` → `{paired, hubUrl, name, state, since, error}`; `POST /api/hub/pair {hubUrl, username, password, name}` (gọi `POST {hubUrl}/v1/machines/pair`), `POST /api/hub/unpair` — cả hai `guardPost`. `serve()` khởi động `hub-link` nếu có `data/hub.json`. Dashboard: trong thẻ "Điện thoại" thêm khối "Hub" (địa chỉ mặc định `https://clauderc.caesarvn.xyz`, tên, mật khẩu, nút Ghép / Ngắt, trạng thái).

- [ ] **Step 1:** Tests: `api/hub: pair qua hub thật lưu token không lưu mật khẩu`, `pair sai mật khẩu → 400 BAD_LOGIN`, `pair không có X-Token-Tracker → 403`, `unpair xoá file`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(tracker): ghép PC với hub từ dashboard`.

### Task 8: Thông báo qua hub

**Files:** Create `hub/notify.js`; Modify `hub/router.js`, `hub-link.js`, `remote.js` (`hub.notify` → link khi online), `tracker.js` (`checkAlerts.push` → link.notify); Test `test/hub.test.js`

**Interfaces — Produces:** `createNotifier({db, fetch, now}) -> {send(userId, n), anyForeground: fn}`; `n = {key, level, title, body, machine, session?}`; ntfy POST tới `https://ntfy.sh/<topic>` với `Title` (mã hoá RFC 2047 nếu không ASCII), `Click: ccremote://session/<machine>/<session>`.

- [ ] **Step 1:** Tests: `notify: app đang foreground thì không gửi`, `trùng key trong 24 h gửi một lần`, `31 thông báo / giờ chỉ gửi 30`, `topic mỗi người khác nhau`.
- [ ] **Step 2–4:** FAIL → viết → PASS.
- [ ] **Step 5:** Commit `feat(hub): thông báo ntfy do hub gửi`.

### Task 9: Triển khai

**Files:** Create `hub/deploy/setup.sh` (Node 24, Caddy, user `cchub`, `/opt/cc-hub`, service, ufw 22/80/443, cron sao lưu 03:30 giữ 7 bản, tắt SSH mật khẩu chỉ khi đã có `~/.ssh/authorized_keys`), `hub/deploy/Caddyfile`, `hub/deploy/cc-hub.service`, `hub/deploy/backup.sh`, `hub/README.md` (cài, tạo admin, mời bạn, cập nhật).

- [ ] **Step 1:** `bash -n hub/deploy/*.sh` sạch lỗi cú pháp.
- [ ] **Step 2:** Chạy hub local `HUB_DATA=… node hub/hub.js serve` + `curl /v1/health` → `{"ok":true,"proto":1}`.
- [ ] **Step 3:** Commit `chore(hub): script triển khai VPS`.

### Task 10: App iOS

**Files:** Create `ios/CCRemote/HubClient.swift`, `ios/CCRemote/LoginView.swift`; Modify `AppModel.swift`, `APIClient.swift`, `SessionModel.swift`, `SessionView.swift`, `HomeView.swift`, `SettingsView.swift`, `Storage.swift`, `ios/tools/smoke-server.js`.

**Interfaces — Produces:** `HubClient` (actor/ObservableObject): `connect(url, token)`, `call(machine, method, params) async throws -> JSON`, `subscribe(machine, session, after, epoch) -> AsyncStream<Event>`, `machines` (published), `setForeground(Bool)`; nối lại 1→30 s; chia mảnh khi JSON > 256 KB. Chế độ kết nối lưu trong `Storage`: `hub` | `tailscale`. Màn đăng nhập (tên, mật khẩu) / "Có mã mời" (mã, tên, mật khẩu). Chọn máy khi > 1 máy. Ô nhắn: PhotosPicker + camera + dán, thu nhỏ ≤ 2000 px JPEG 0.85, thumb ≤ 256 px, tối đa 10. Cài đặt: thiết bị, đăng xuất, đăng xuất mọi nơi, bật thông báo (`ntfy://…`), "Gửi ảnh gốc".

- [ ] **Step 1:** Mở rộng `smoke-server.js` thành hub giả (đăng nhập + WS + 1 máy giả).
- [ ] **Step 2:** Viết code Swift.
- [ ] **Step 3:** Build CI + smoke (cần push — **chờ người dùng xác nhận**).
- [ ] **Step 4:** Commit `feat(ios): đăng nhập hub, chọn máy, gửi ảnh`.
