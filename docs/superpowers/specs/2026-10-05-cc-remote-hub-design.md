# CC Remote Hub — điều khiển Claude Code từ điện thoại qua VPS, nhiều người dùng

Ngày: 2026-10-05 · Trạng thái: chờ duyệt

## 1. Mục tiêu

Hiện tại app iOS **CC Remote** nói chuyện thẳng với `remote.js` trên PC qua Tailscale (`tailscale serve` cổng 7789).
Điện thoại phải bật VPN Tailscale, iOS hay tắt ngầm VPN nên thỉnh thoảng mất kết nối, và chỉ một người dùng được.

Mục tiêu: dựng **hub** trên VPS làm trạm trung chuyển giữa app và PC.

- Điện thoại chỉ cần internet, **không cần VPN**.
- **Nhiều người dùng** (chủ + 1–2 người bạn), mỗi người đăng nhập tài khoản/mật khẩu riêng, **không ai chạm được vào máy
  hay phiên của người khác**.
- **Đăng nhập một lần dùng mãi**: không bao giờ tự đăng xuất.
- Thêm: **gửi ảnh từ điện thoại**, **tin nhắn lớn** (không còn trần 1 MB).
- Thông báo (ntfy) do hub gửi, không ai phải tự đặt topic.
- Thiết kế cho dùng lâu dài: giao thức riêng giữa app ⇄ hub ⇄ PC (không phải đường hầm HTTP).

### Không làm (ngoài phạm vi)

- Dashboard theo dõi trên VPS. Dashboard vẫn chạy trên từng PC (`127.0.0.1:7788`) như hiện tại; app chỉ hiện tài khoản
  (5 giờ / tuần / hôm nay / nút Đổi) và điều khiển phiên như bây giờ.
- Hub lưu nội dung phiên (tin nhắn, code, diff, ảnh). Mọi thứ chỉ đi qua; lịch sử vẫn nằm trên PC.
- Mã hoá đầu-cuối. Chủ VPS được tin (quyết định A): phân quyền theo tài khoản, chủ VPS về kỹ thuật đọc được lưu lượng.
- Tự đăng ký công khai, Android, web app / Web Push, tự dựng ntfy.

### Quyết định đã chốt

| Câu hỏi | Chọn |
|---|---|
| VPS gánh phần nào | Trung chuyển điều khiển (không gánh dashboard) |
| Mức kín | Kín giữa người dùng với nhau; chủ VPS được tin |
| Điện thoại | Giữ app iOS (ESign), thêm đăng nhập |
| Kiểu trung chuyển | Giao thức riêng qua WebSocket (không phải đường hầm HTTP) |
| Phiên đăng nhập | Không hết hạn; chỉ mất khi tự đăng xuất / thu hồi / admin khoá |
| Tin nhắn | Tới 1 triệu ký tự, tổng một tin ≤ 50 MB, có ảnh |
| Tên miền | `clauderc.caesarvn.xyz` → `36.50.135.173` (A record, Cloudflare "DNS only") |

## 2. Kiến trúc

```
 iPhone (CC Remote)  ──wss──▶  Hub (VPS)  ◀──wss──  Agent (PC: tracker.js + remote.js)
                               │ SQLite: người dùng, thiết bị, máy, mã mời, topic ntfy
                               └─▶ ntfy.sh (thông báo)
```

- **Hub** (`hub/`, Node 24, thư viện ngoài duy nhất là `ws`): xác thực, giữ kết nối, định tuyến tin giữa các kết nối
  **cùng người dùng**, gửi thông báo. Không lưu nội dung phiên.
- **Agent**: tracker hiện tại. `remote.js` thêm đường kết nối **ra** hub (WebSocket client có sẵn trong Node, không thêm
  thư viện). Phần lõi (lớp `Session`, hook VS Code, đổi tài khoản) giữ nguyên.
- **App iOS**: thêm đăng nhập / mã mời, chọn máy, gửi ảnh; nói chuyện với hub qua `URLSessionWebSocketTask`.

Mỗi app và mỗi agent giữ **một** WebSocket tới `wss://clauderc.caesarvn.xyz/v1/ws`. Agent chỉ kết nối ra ngoài: PC
không mở cổng, không cần Tailscale.

## 3. Đăng nhập, mã mời, ghép máy

### Tài khoản

- `node hub.js init` (trên VPS): tạo tài khoản đầu tiên, quyền **admin**.
- `node hub.js invite`: in **mã mời** dùng một lần, hết hạn 24 giờ. Người được mời nhập mã trong app rồi **tự đặt** tên
  đăng nhập + mật khẩu (admin không biết mật khẩu của họ).
- Admin chỉ có: tạo mã mời, khoá / mở / xoá người dùng (`node hub.js users|lock|unlock|delete`). **Không có** API nào
  xem máy hay phiên của người khác.
- Mật khẩu: scrypt (`crypto.scrypt`, muối 16 byte, N=2^15), so sánh `timingSafeEqual`. Tối thiểu 8 ký tự.
- Sai mật khẩu 5 lần trong 15 phút (theo tên đăng nhập + IP) → từ chối 15 phút.

### Token

- **Token thiết bị** (app) và **token máy** (agent): 32 byte ngẫu nhiên (base64url); DB chỉ lưu SHA-256.
- **Không hết hạn**, không có thời gian chờ không hoạt động. Đổi mật khẩu **không** thu hồi token; có nút riêng
  "Đăng xuất mọi nơi". Mất token chỉ khi: tự đăng xuất, bị thu hồi (từ app hoặc PC), hoặc tài khoản bị khoá / xoá.
- Khoá / xoá tài khoản hoặc thu hồi token → hub đóng ngay các kết nối đang dùng token đó.

### HTTP (ngoài WebSocket, chỉ cho xác thực)

| Đường dẫn | Vào | Ra |
|---|---|---|
| `POST /v1/auth/register` | `{invite, username, password, deviceName}` | `{token, user}` |
| `POST /v1/auth/login` | `{username, password, deviceName}` | `{token, user}` |
| `POST /v1/auth/logout` | header `Authorization: Bearer <token>` | `{ok}` |
| `POST /v1/machines/pair` | `{username, password, machineName}` | `{machineToken, machineId}` |
| `GET /v1/health` | — | `{ok, proto}` (không lộ gì khác) |

Tên đăng nhập: `^[a-z0-9_.-]{3,32}$` (không phân biệt hoa thường). Lỗi trả `{error: CODE, message}` tiếng Việt;
sai tên hay sai mật khẩu đều trả cùng một lỗi `BAD_LOGIN`.

### Ghép PC

Dashboard local, thẻ **Điện thoại** (đổi thành "Điện thoại · Hub"): ô địa chỉ hub (mặc định
`https://clauderc.caesarvn.xyz`), tên đăng nhập, mật khẩu → `POST /v1/machines/pair`. PC lưu `{hubUrl, machineId,
machineToken}` vào `data/hub.json`, **không** lưu mật khẩu. Tên máy mặc định là hostname, đổi được. Có nút
"Ngắt khỏi hub" (xoá `data/hub.json` + thu hồi token trên hub).

## 4. Giao thức WebSocket

### Bắt tay

1. Mở `wss://…/v1/ws`. Tin đầu tiên (trong 10 giây):
   `{type:'hello', proto:1, role:'app'|'agent', token, client:{name, version}}`.
2. Hub trả `{type:'welcome', proto:1, user:{id, username, admin}, machines:[{id, name, online, lastSeen}], ntfy}`
   (agent nhận `{type:'welcome', proto:1, machineId}`), hoặc `{type:'error', code}` rồi đóng.
3. `proto` lệch → `{type:'error', code:'UPGRADE_APP' | 'UPGRADE_AGENT'}`: app hiện "Cần cập nhật …".

Token **không** đặt trên URL (khỏi lọt vào log của Caddy).

### Loại tin (khung chữ = JSON)

| type | Chiều | Ý nghĩa |
|---|---|---|
| `req` `{id, machine, method, params}` | app → hub → agent | Gọi một hàm trên máy. Hub gắn thêm `conn` (id kết nối app) trước khi chuyển. |
| `res` `{id, ok, result \| error}` | agent → hub → app | Trả lời đúng `conn` đã hỏi. Quá 30 giây không có → hub tự trả `{ok:false, error:{code:'TIMEOUT'}}`. |
| `req` `{id, machine:'hub', method}` | app → hub | Hàm của chính hub (mục 4.3). |
| `sub` `{machine, session, after, epoch}` / `unsub` | app → hub → agent | Theo dõi / thôi theo dõi một phiên. |
| `event` `{session, data}` | agent → hub → app | Sự kiện của phiên → các app đang `sub` phiên đó. |
| `event` `{to:conn, session, data}` | agent → hub → app | Phát lại sau `sub`, chỉ cho một kết nối. |
| `event` `{scope:'user', data}` | agent → hub → app | Sự kiện chung (hạn mức, xin quyền mới, danh sách phiên đổi) → mọi app của người đó. |
| `machine` `{id, name, online, lastSeen}` | hub → app | Máy vào / ra mạng, đổi tên. |
| `presence` `{foreground, notifies}` | app → hub | App đang mở hay ở nền; `notifies`: đang chạy nền và tự bắn thông báo trên máy (để quyết định có đẩy thông báo). |
| `notify` `{key, level, title, body, session?}` | agent → hub | Yêu cầu gửi thông báo (mục 6). |
| `part` | hai chiều | Mảnh của tin lớn (mục 5). |

### 4.1 Luật cách ly (quan trọng nhất)

- Mỗi kết nối gắn với **một** `userId` lúc `hello`; không đổi được.
- `req` / `sub` của app: `machine` phải thuộc `userId` của kết nối **và** đang online. Không thì trả `NOT_FOUND` —
  cùng một lỗi cho "không tồn tại" và "không phải của bạn" để không dò được id máy của người khác.
- Tin từ agent: hub tự gắn `machine` theo kết nối (agent không tự khai). `res` / `event{to}` chỉ được gửi tới `conn`
  thuộc cùng `userId`; sai thì bỏ và ghi log.
- Mọi truy vấn DB của hub đều có điều kiện `user_id = ?`.

### 4.2 Hàm trên máy (`method`)

Tương ứng 1–1 với API `/v1/*` hiện có của `remote.js`, để lõi giữ nguyên:

`state`, `projects`, `projects.sessions {cwd}`, `capabilities`, `sessions.create {cwd, text, images?, mode, model, …}`,
`sessions.get {id}`, `sessions.send {id, text, images?}`, `sessions.permission {id, requestId, decision, …}`,
`sessions.image {id, name}` (ảnh đầy đủ đã gửi), `sessions.interrupt {id}`, `sessions.mode {id, mode}`, `sessions.model {id, model}`, `sessions.settings {id, …}`,
`sessions.attach {id, on}`, `sessions.close {id}`, `accounts.switch {id, sessionId?, text?}`, `alwaysOn {on}`.

(Bỏ: ghép thiết bị và ntfy ở phía PC — nay do hub lo.)

### 4.3 Hàm của hub (`machine:'hub'`)

`devices` (thiết bị đã đăng nhập của mình), `devices.revoke {id}`, `logoutAll`, `machines`, `machines.rename {id, name}`,
`machines.revoke {id}`, `password {old, new}`, `ntfy` (topic + link đăng ký).

### 4.4 Kết nối lại

- Hai phía tự nối lại với thời gian chờ tăng dần 1 → 2 → 4 … tối đa 30 giây (có nhiễu ngẫu nhiên).
- Ping WebSocket mỗi 20 giây; im quá 60 giây → coi là rớt.
- App nối lại xong: `sub` lại mọi phiên đang mở với `after` = seq cuối đã nhận, `epoch` hiện có → agent phát lại phần
  thiếu (cơ chế seq/epoch đã có trong `Session`): không mất, không lặp.
- Agent nối lại: hub báo `machine{online:true}` cho các app; app gọi lại `state`.
- Máy offline: app hiện "Máy đang tắt"; **không** xếp hàng lệnh chờ máy bật.
- Xin quyền mở trên nhiều thiết bị: trả lời đầu tiên thắng (agent đã chỉ nhận một lần mỗi `requestId`), các thiết bị
  khác nhận sự kiện `decided` và đóng hộp hỏi.

## 5. Tin nhắn lớn và ảnh

### 5.1 Chia mảnh

- Khung WebSocket tối đa 1 MB. Tin JSON lớn hơn 256 KB được bên gửi chia thành các khung **nhị phân** `part`:
  4 byte độ dài phần đầu + phần đầu JSON `{type:'part', pid, idx, last, to?}` + dữ liệu.
- Hub **chuyển từng mảnh ngay** theo phần đầu (không gom cả tin trong RAM), đếm byte; một `pid` vượt **50 MB** → huỷ,
  báo `TOO_LARGE`. Mảnh đầu mang luôn `machine` / `conn` đích để hub kiểm tra cách ly như tin thường.
- Bên nhận ghép đủ mảnh rồi xử lý như một tin JSON bình thường. Mỗi kết nối tối đa 4 tin lớn đang truyền cùng lúc;
  một `pid` im quá 60 giây → bỏ.
- Tin chữ tối đa **1 000 000 ký tự** (thay cho 100 000 hiện tại trong `Session.send`).

### 5.2 Ảnh từ điện thoại

- App: nút 📎 trong ô nhắn — thư viện ảnh (PhotosPicker), chụp ảnh, dán ảnh. Tối đa **10 ảnh / tin**, có hoặc không
  kèm chữ.
- App thu nhỏ trước khi gửi: cạnh dài ≤ 2000 px, JPEG chất lượng 0.85 (PNG giữ nguyên nếu là ảnh chụp màn hình nhỏ
  hơn 2000 px). Cài đặt "Gửi ảnh gốc" để bỏ thu nhỏ.
- Gửi trong `params.images: [{mime, data(base64), name, thumb(base64 JPEG ≤ 256 px, app tự tạo)}]` của `sessions.send` / `sessions.create` (đi qua chia mảnh).
- Agent:
  - **Phiên do app mở** (`claude -p` stream-json): đưa ảnh thành khối `{type:'image', source:{type:'base64',
    media_type, data}}` trong `message.content` cùng khối chữ.
  - **Phiên VS Code qua hook** (chỉ chèn được chữ): lưu ảnh vào `data/uploads/<sessionId>/<thời gian>-<n>.<ext>`,
    tin nhắn chèn vào ghi kèm danh sách đường dẫn và dặn Claude dùng tool Read để xem.
  - Kiểm tra `mime` ∈ `image/jpeg|png|gif|webp` và đúng chữ ký đầu file; sai thì từ chối `BAD_IMAGE`.
  - Dọn `data/uploads` sau 7 ngày (chạy trong `sweep`).
- Sự kiện `user` của phiên có thêm `images: [{name, thumb}]` (thumb do app gửi kèm — PC không có thư viện xử lý ảnh); app hiện ảnh nhỏ, bấm để xem ảnh
  đầy đủ qua `sessions.image {id, name}`.

## 6. Thông báo

- Agent gửi `notify {key, level, title, body, session?}` cho: Claude hỏi / xin quyền, xong lượt, bị dừng, hết hạn mức
  (các chỗ đang gọi `hub.notify` trong `remote.js`) và cảnh báo của tracker (hạn mức ≥ ngưỡng, đăng nhập sắp hết hạn
  — các `push` trong `checkAlerts`).
- Hub đẩy khi người dùng **không có app nào đang `presence{foreground:true}`**. Sự kiện của phiên (`notify` có `session`)
  cũng không đẩy khi có app `presence{notifies:true}` (chạy nền, tự báo) — không thì một việc báo hai lần; cảnh báo của
  tracker (không có `session`) vẫn đẩy.
- Kênh: `https://ntfy.sh/<topic>`, topic 128 bit ngẫu nhiên do hub tạo cho mỗi người dùng (lưu trong DB). App có nút
  "Bật thông báo" mở `ntfy://ntfy.sh/<topic>` để đăng ký trong app ntfy. Header `Click: ccremote://session/<machine>/<id>`.
- Chống spam: bỏ `notify` trùng `key` trong 24 giờ (khoá phải ổn định — không chứa mốc thời gian dao động); tối đa
  30 thông báo / giờ / người.
- Bỏ cài đặt ntfy ở phía PC (dashboard và `remote.json`) sau khi chuyển xong (mục 8).

## 7. Hub: lưu trữ và triển khai

### SQLite (`hub/data/hub.db`, `node:sqlite`)

```
users    (id, username UNIQUE, pass_hash, admin, locked, created_at)
invites  (code_hash, created_by, expires_at, used_by, used_at)
devices  (id, user_id, name, token_hash UNIQUE, created_at, last_seen)
machines (id, user_id, name, token_hash UNIQUE, created_at, last_seen)
ntfy     (user_id PRIMARY KEY, topic)
audit    (t, user_id, ip, event, detail)    -- đăng nhập, sai mật khẩu, ghép máy, thu hồi, khoá
```

### Triển khai (VPS `36.50.135.173`, Ubuntu 26.04, 2 CPU / 2 GB / 30 GB)

- Node 24 LTS; hub chạy bằng systemd (`cc-hub.service`, user riêng `cchub`, không phải root), `Restart=always`.
- **Caddy** trước hub: `clauderc.caesarvn.xyz { reverse_proxy 127.0.0.1:7790 }`, tự xin / gia hạn chứng chỉ
  Let's Encrypt (bản ghi A đang để "DNS only" — giữ nguyên để Caddy xin chứng chỉ trực tiếp).
- Hub nghe `127.0.0.1:7790`, lấy IP thật từ `X-Forwarded-For` do Caddy đặt (chỉ tin khi kết nối đến từ loopback).
- `ufw`: chỉ mở 22, 80, 443.
- SSH: đăng nhập bằng khoá, **tắt đăng nhập mật khẩu**, đổi mật khẩu root (mật khẩu hiện tại đã nằm trong file
  `vps.txt` và trong cuộc trò chuyện).
- Sao lưu `hub.db` mỗi đêm (`sqlite3 .backup`), giữ 7 bản.
- `hub/deploy/setup.sh`: cài Node, Caddy, user, service, ufw, cron sao lưu — chạy một lần. Cập nhật: `git pull` +
  `systemctl restart cc-hub`.

## 8. Chuyển đổi

1. Hub + đăng nhập + agent nối hub + app đăng nhập — **ngang tính năng hiện tại**. Đường cũ (Tailscale, cổng 7789,
   ghép mã 6 số) **vẫn chạy song song**; app có lựa chọn "Kết nối: Hub / Tailscale (cũ)".
2. Tin nhắn lớn + ảnh.
3. Thông báo qua hub.
4. Khi 1–3 chạy ổn ít nhất một tuần: gỡ đường cũ (HTTP server 7789 cho điện thoại, ghép mã 6 số, ntfy phía PC, mục
   Tailscale trên dashboard). Hook VS Code vẫn gọi `127.0.0.1:7789/v1/hook/*` nên server loopback cho hook **giữ lại**.

## 9. Thay đổi theo thành phần

- **`hub/`** (mới): `hub.js` (CLI + server), `db.js`, `auth.js`, `router.js` (định tuyến + cách ly + chia mảnh),
  `notify.js`, `deploy/`. Thư viện: `ws`.
- **`remote.js`**: tách lớp vỏ HTTP khỏi lõi thành `call(method, params, ctx)` dùng chung cho HTTP cũ và hub; người
  theo dõi phiên (`s.clients`) có thêm loại "kết nối hub"; ảnh trong `send`; nâng trần tin nhắn.
- **`hub-link.js`** (mới, phía PC): kết nối / nối lại tới hub, `hello`, chuyển `req` → `call`, `sub` → thêm người theo
  dõi, đẩy `event` / `notify`, chia / ghép mảnh.
- **`tracker.js`**: khởi động `hub-link` khi có `data/hub.json`; `checkAlerts` gửi `notify` qua hub; API
  `/api/hub` (ghép / ngắt / trạng thái) có `guardPost`.
- **`dashboard.html`**: thẻ "Điện thoại · Hub" (ghép bằng tên + mật khẩu, trạng thái kết nối).
- **App iOS**: `HubClient` (WebSocket, req/res, sub, nối lại, presence), màn đăng nhập / nhập mã mời, chọn máy,
  đính kèm ảnh + ảnh nhỏ trong hội thoại, Cài đặt (thiết bị, đăng xuất, đăng xuất mọi nơi, bật thông báo, chế độ kết
  nối cũ / mới).

## 10. Kiểm thử

- **Hub** (`node:test`, hub thật trên cổng ngẫu nhiên, DB tạm):
  - mã mời (một lần, hết hạn), đăng nhập, khoá sau 5 lần sai, token không hết hạn, đăng xuất / thu hồi / khoá đóng
    kết nối ngay;
  - **cách ly**: người B dùng `machine` id của A, `conn` của A, `pid` chia mảnh trỏ sang A, agent B gửi `res` /
    `event{to}` tới kết nối của A — tất cả đều bị chặn và không lộ việc id đó có tồn tại;
  - định tuyến req/res, timeout 30 giây, sub/unsub, phát lại sau nối lại;
  - chia mảnh: tin 5 MB qua đủ, tin 51 MB bị huỷ, hub không giữ cả tin trong RAM;
  - notify: không đẩy khi app đang mở, chống trùng `key`, trần 30 / giờ.
- **Agent**: hub giả; các test hiện có của `remote.js` chạy qua `call(...)`; ảnh vào phiên `claude -p` (fake-claude
  kiểm tra khối image) và phiên hook (file được lưu, tin có đường dẫn).
- **App**: build CI như hiện tại; smoke test với hub giả (`ios/tools/smoke-server.js` mở rộng thành hub giả) và chụp
  màn hình đăng nhập, chọn máy, gửi ảnh.
- **Triển khai**: chạy `setup.sh` trên VPS, kiểm tra `https://clauderc.caesarvn.xyz/v1/health`, ghép PC, đăng nhập app
  qua 4G (không wifi, không Tailscale).
