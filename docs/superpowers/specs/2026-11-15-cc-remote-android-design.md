# CC Remote cho Android — thiết kế

Ngày: 2026-11-15. Trạng thái: đã chốt, giao làm.

## 1. Mục tiêu

App Android native làm **đúng những gì app iOS (`ios/CCRemote`) đang làm**, nói chuyện với hub
(`https://clauderc.caesarvn.xyz`, giao thức ở `2026-10-05-cc-remote-hub-design.md` mục 4–6), **không sửa hub,
không sửa `remote.js`**. App iOS là bản tham chiếu: hành vi, chữ tiếng Việt, luồng màn hình, xử lý lỗi — đọc code Swift
và làm theo, đừng tự nghĩ lại.

Hơn iOS ở một điểm mà Android cho phép: **giữ kết nối nền bằng foreground service** → thông báo tức thì ngay trong app,
có nút **Cho phép / Từ chối** xin quyền và **Trả lời** ngay trên thông báo, không cần ntfy.

### Ngoài phạm vi

- Không Google Play, không Firebase/FCM (không có server push riêng; hub chỉ có ntfy).
- Không tablet layout riêng (chạy được trên tablet là đủ), không widget, không Wear OS.
- Không thêm hàm mới ở hub hay agent. Thiếu gì thì ghi lại trong báo cáo, không tự sửa phía server.

## 2. Công nghệ

| Mục | Chọn |
|---|---|
| Ngôn ngữ / UI | Kotlin, Jetpack Compose, Material 3 (dynamic color Android 12+, có dark mode) |
| SDK | `minSdk 26`, `compileSdk`/`targetSdk 36` (máy có sẵn platform android-36, build-tools 36.x) |
| Build | Gradle wrapper (Kotlin DSL) + version catalog `gradle/libs.versions.toml`, AGP + Kotlin bản ổn định mới nhất chạy được với JDK 21 |
| WebSocket / HTTP | OkHttp (`pingInterval(20s)`), một `OkHttpClient` dùng chung |
| JSON | kotlinx.serialization (`ignoreUnknownKeys = true`, `explicitNulls = false`) |
| Bất đồng bộ | Coroutines + `StateFlow`; ViewModel cho mỗi màn hình |
| Ảnh | Coil 3 (hiện base64/bytes), ảnh phóng to bằng zoom tự viết (`transformable`) hoặc thư viện nhỏ |
| Markdown | Tự viết parser tối giản giống `ios/CCRemote/Markdown.swift` (đoạn, tiêu đề, danh sách, code block cuộn ngang, inline code, đậm/nghiêng, link, **bảng**: không đè chữ, vừa màn hình hoặc cuộn ngang, căn cột theo `:---:`, `\|` và `<br>` trong ô — xem commit `17d0bf7`). Không kéo thư viện markdown nặng |
| Lưu trữ | Token hub trong `EncryptedSharedPreferences` (hoặc DataStore + Keystore); cài đặt thường trong DataStore |
| DI | Không dùng Hilt — một object `AppGraph` tự dựng là đủ |

Package / applicationId: **`vn.peo.ccremote`** (khớp bundle id iOS). Tên hiển thị: **CC Remote**. Icon: dùng lại
`ios/CCRemote/Assets.xcassets/AppIcon.appiconset/icon.png` (adaptive icon: foreground là ảnh này thu nhỏ, nền cùng màu).
Chỉ dọc + ngang, edge-to-edge, xử lý `imePadding` cho ô nhắn.

## 3. Cấu trúc

```
android/
  settings.gradle.kts, build.gradle.kts, gradle/libs.versions.toml, gradlew(.bat), gradle/wrapper/
  app/src/main/java/vn/peo/ccremote/
    data/      Models.kt (= Models.swift), HubClient.kt (= HubClient.swift), Api.kt (= APIClient.swift: các method
               state, projects, sessions.* …), Storage.kt, Chunking.kt (khung nhị phân "part")
    session/   SessionModel.kt (= SessionModel.swift: sub/after/epoch, ghép sự kiện, tránh lặp)
    ui/        Login, Home, Project, NewSession, Session, SessionSettings, Settings, ImageViewer, Markdown, theme/
    notify/    HubService.kt (foreground service), Notifier.kt (= Notifier.swift), NotificationActions (BroadcastReceiver)
    MainActivity.kt, App.kt (Application, AppGraph)
  app/src/test/   unit test JVM: Chunking, parse Event, Markdown, reconnect/backoff
  tools/          smoke.sh (xem mục 7)
```

## 4. Tính năng (đối chiếu iOS)

Làm theo từng file Swift tương ứng; mọi chữ trên màn hình bằng tiếng Việt giống iOS.

1. **Đăng nhập hub** (`LoginView.swift`): địa chỉ hub (mặc định `https://clauderc.caesarvn.xyz`), tên + mật khẩu,
   HTTP login như iOS → token. **Không bao giờ tự đăng xuất**: chỉ xoá token khi hub trả lỗi xác thực thật
   (`onUnauthorized` của iOS), không phải khi mất mạng.
2. **Kết nối** (`HubClient.swift`): hello/welcome, req/res có timeout, sub/unsub/event, `machine`, `presence`, chia mảnh
   > 256 KB, tự nối lại 1 → 30 giây có nhiễu, `sub` lại mọi phiên đang mở với `after`/`epoch`, `UPGRADE_APP`.
3. **Màn hình chính** (`HomeView.swift`): chọn máy (online/offline, "Máy đang tắt"), tài khoản + hạn mức 5h/7d,
   chuyển tài khoản, cảnh báo của máy (PC alerts), danh sách phiên (trạng thái chạy / cần duyệt / rảnh), dự án,
   đổi tên máy, kéo để làm mới.
4. **Dự án / Phiên mới** (`ProjectView.swift`, `NewSessionView.swift`): phiên cũ của dự án, tạo phiên với chữ + ảnh,
   chế độ quyền, model, effort.
5. **Phiên** (`SessionView.swift`, `SessionModel.swift`): luồng sự kiện (chữ markdown, thinking, tool gọi/kết quả gấp
   gọn, diff sửa file, ảnh Claude xem trên máy, lỗi, kết quả lượt có chi phí/thời gian), xin quyền (cho phép / luôn cho
   phép / từ chối kèm lời nhắn), câu hỏi AskUserQuestion, duyệt kế hoạch, gợi ý, dừng (interrupt), đổi mode/model,
   attach/close, lệnh `/` (capabilities.commands). Không giật xuống cuối khi đang đọc tin cũ; có nút "xuống cuối".
6. **Cài đặt phiên** (`SessionSettingsView.swift`) và **Cài đặt** (`SettingsView.swift`): thiết bị đã đăng nhập, thu
   hồi, đăng xuất mọi nơi, đổi mật khẩu, ntfy, "Gửi ảnh gốc", bật/tắt kết nối nền (mục 5).
7. **Ảnh** (`ImageAttach.swift`): chọn từ thư viện (Photo Picker), chụp ảnh (`TakePicture` + FileProvider), dán từ
   clipboard; tối đa 10 ảnh/tin; thu nhỏ cạnh dài ≤ 2000 px, JPEG 0.85, thumb ≤ 256 px; gửi kiểu
   `images:[{mime,data,name,thumb}]`. Xem ảnh đầy đủ qua `sessions.image`, phóng to/kéo được.
8. **Deep link**: intent-filter `ccremote://session/<machine>/<id>` (ntfy dùng header `Click` này) → mở thẳng phiên.

## 5. Chạy nền và thông báo (phần riêng của Android)

- **`HubService`** — foreground service, `foregroundServiceType="remoteMessaging"` (Android 14+; khai quyền
  `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_REMOTE_MESSAGING`), thông báo thường trực mức thấp "Đang giữ kết nối với
  hub". Service **sở hữu** `HubClient` (một kết nối cho cả app); Activity chỉ bind/quan sát. Bật mặc định sau khi đăng
  nhập; tắt được trong Cài đặt. Tự chạy lại sau khởi động máy (`BOOT_COMPLETED`) nếu đang bật.
- **presence**: app trên màn hình → `{foreground:true}`; ở nền mà service chạy và có quyền `POST_NOTIFICATIONS` →
  `{foreground:false, notifies:true}` (hub thôi đẩy ntfy cho sự kiện phiên, tránh báo trùng); service tắt → app ngắt
  kết nối khi vào nền như iOS, ntfy lo phần còn lại.
- **Notifier** theo đúng luật của `Notifier.swift` (cái gì báo, khi nào; phiên VS Code/terminal chỉ báo khi
  `attached || pcAway`; không báo phiên đang mở trên màn hình). Kênh thông báo riêng: "Xin quyền / câu hỏi" (cao),
  "Xong lượt" (mặc định), "Cảnh báo máy" (mặc định), "Kết nối nền" (thấp).
- **Nút trên thông báo**: xin quyền → **Cho phép** / **Từ chối** gọi `sessions.permission` thẳng từ
  `BroadcastReceiver` (qua service); xong lượt / câu hỏi chữ → **Trả lời** bằng `RemoteInput` → `sessions.send`.
  Khi thiết bị khác trả lời trước (sự kiện `decided`) thì huỷ thông báo. Bấm thông báo → mở phiên.
- Xin `POST_NOTIFICATIONS` (Android 13+) lúc bật kết nối nền; gợi ý (không ép) tắt tối ưu pin với nút mở cài đặt.
- ntfy vẫn là đường dự phòng: nút "Bật thông báo ntfy" mở `ntfy://…` như iOS.

## 6. Ký và phát hành

- Một **keystore release** cố định (nếu đổi khoá thì Android không cho cài đè bản mới): tạo một lần bằng `keytool`,
  lưu ở `%USERPROFILE%\.ccremote\android-release.jks` (ngoài repo) + mật khẩu trong
  `%USERPROFILE%\.ccremote\android-signing.properties`; đưa lên GitHub secrets
  `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
  Gradle đọc từ biến môi trường (CI) hoặc file properties kia (máy local); thiếu cả hai thì build release ký bằng
  khoá debug và in cảnh báo. Không bao giờ commit keystore / mật khẩu (thêm vào `.gitignore`).
- `.github/workflows/android.yml`: `ubuntu-latest`, chạy khi đổi `android/**` hoặc chính file; JDK 21 → `./gradlew
  testDebugUnitTest assembleRelease` → upload artifact → release **`android-latest`** (prerelease, tên
  "CC Remote (Android, bản mới nhất)"), file `CCRemote.apk` (`--clobber`). Giống hệt mẫu `ios.yml`.
- `versionName` theo app iOS (`1.2.0`), `versionCode` = `github.run_number` trên CI (local = 1) để cài đè được.
- R8/minify bật cho release, có `proguard-rules.pro` giữ lớp kotlinx.serialization.

## 7. Kiểm thử

- Unit test JVM: ghép/chia mảnh khớp `hub/proto.js` (có test dữ liệu chia đúng ranh giới 256 KB), parse đủ các
  `kind` của Event mà `Models.swift` có, Markdown (bảng có `\|`, `<br>`, căn cột), backoff.
- **Smoke trên emulator (local)**: `android/tools/smoke.sh` — chạy `node ios/tools/smoke-server.js <tmp>` (hub thật +
  remote.js thật + claude giả; cần `npm ci` trong `hub/`), tạo AVD từ `system-images;android-36.1;google_apis;x86_64`
  nếu chưa có, cài APK debug, nạp token/địa chỉ hub (`http://10.0.2.2:<port>`) từ `smoke.json` qua intent extra chỉ có
  ở bản debug, mở các màn hình (login, home, phiên có markdown + bảng, phiên đang xin quyền, cài đặt) và chụp
  `adb exec-out screencap -p` vào `android/build/smoke/`. Bản debug cho phép cleartext tới `10.0.2.2`; bản release chỉ HTTPS.
- Xong việc: thử đăng nhập hub thật trên emulator (tài khoản do người dùng nhập — không đoán, không dùng mật khẩu
  trong `vps.txt`; nếu không có thì bỏ qua bước này và ghi lại).

## 8. Không được làm

- Không sửa `hub/`, `remote.js`, `hook.js`, `tracker.js`, `ios/` (trừ khi cần một dòng tài liệu).
- Không SSH vào VPS, không đọc/chép `vps.txt`.
- Chỉ nhánh `master`, không tạo nhánh khác.
