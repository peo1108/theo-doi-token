import SwiftUI
import PhotosUI
import UIKit
import ImageIO

/// Ảnh đang đính kèm trong ô nhắn (chưa gửi).
struct PickedImage: Identifiable {
    let id = UUID()
    let image: UIImage
}

enum ImagePrep {
    static let maxSide: CGFloat = 2000
    static let thumbSide: CGFloat = 256
    static let maxCount = 10
    /// Cài đặt: gửi ảnh gốc (không thu nhỏ)
    static var sendOriginal: Bool {
        get { UserDefaults.standard.bool(forKey: "sendOriginal") }
        set { UserDefaults.standard.set(newValue, forKey: "sendOriginal") }
    }

    static func resized(_ img: UIImage, maxSide: CGFloat) -> UIImage {
        let w = img.size.width, h = img.size.height
        let scale = min(1, maxSide / max(w, h, 1))
        if scale >= 1 && img.imageOrientation == .up { return img }
        let size = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        return UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// Ảnh đã nén để gửi cho máy tính (giá trị thuần chuỗi: nén ở luồng nền rồi đưa về luồng chính được).
    struct Payload: Sendable {
        let data: String
        let name: String
        let thumb: String
        var dict: [String: Any] { ["mime": "image/jpeg", "data": data, "name": name, "thumb": thumb] }
    }

    /// Ảnh -> JPEG base64 + ảnh nhỏ (cạnh dài ≤ 2000 px trừ khi bật "Gửi ảnh gốc"). Nặng (vài trăm ms mỗi ảnh lớn):
    /// gọi từ luồng nền.
    static func payload(_ img: UIImage, index: Int) -> Payload? {
        let full = sendOriginal ? resized(img, maxSide: .greatestFiniteMagnitude) : resized(img, maxSide: maxSide)
        guard let data = full.jpegData(compressionQuality: sendOriginal ? 0.95 : 0.85),
              let thumb = resized(img, maxSide: thumbSide).jpegData(compressionQuality: 0.6) else { return nil }
        return Payload(data: data.base64EncodedString(), name: "anh-\(index + 1).jpg", thumb: thumb.base64EncodedString())
    }

    static func image(base64: String?) -> UIImage? {
        guard let s = base64, let d = Data(base64Encoded: s) else { return nil }
        return UIImage(data: d)
    }
}

/// Chụp ảnh bằng camera (UIImagePickerController).
struct CameraPicker: UIViewControllerRepresentable {
    let onPick: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onPick(img) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// Dải ảnh đã chọn phía trên ô nhắn (bấm × để bỏ).
struct AttachmentStrip: View {
    @Binding var picks: [PickedImage]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(picks) { p in
                    Image(uiImage: p.image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                picks.removeAll { $0.id == p.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .offset(x: 5, y: -5)
                        }
                }
            }
            .padding(.horizontal, 14).padding(.top, 8)
        }
    }
}

/// Ảnh lấy từ máy tính (sessions.image). Giữ dữ liệu nén và ảnh thu nhỏ, mỗi loại tối đa 40 MB;
/// ảnh cỡ gốc chỉ giải mã khi mở xem. Nhiều nơi cùng hỏi một ảnh thì chỉ tải một lần.
/// Phần giải mã nặng (base64 vài MB, thu nhỏ, bung ảnh gốc) chạy ngoài luồng chính -> cuộn không giật.
@MainActor
enum RemoteImages {
    private static let blobs: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 40 << 20
        return c
    }()
    private static let thumbs: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 40 << 20
        return c
    }()
    private static var inflight: [String: Task<Data?, Never>] = [:]
    /// ảnh nhỏ kèm sự kiện không giải mã được -> nhớ để không giải mã lại mỗi lần vẽ
    private static var badThumbs: Set<String> = []

    private static func data(_ api: APIClient, _ sessionId: String, _ name: String) async -> Data? {
        let key = "\(sessionId)/\(name)"
        if let d = blobs.object(forKey: key as NSString) { return d as Data }
        if let t = inflight[key] { return await t.value }
        let t = Task<Data?, Never> {
            guard let r: ImageData = try? await api.call("POST", "/v1/sessions/\(sessionId)/image", body: ["name": name]) else { return nil }
            let b64 = r.data
            return await Task.detached(priority: .userInitiated) { Data(base64Encoded: b64) }.value
        }
        inflight[key] = t
        let d = await t.value
        inflight[key] = nil
        if let d { blobs.setObject(d as NSData, forKey: key as NSString, cost: d.count) }
        return d
    }

    private static func thumbKey(_ sessionId: String, _ name: String, _ maxPixel: CGFloat) -> NSString {
        "\(sessionId)/\(name)@\(Int(maxPixel))" as NSString
    }

    private static func cost(_ img: UIImage) -> Int {
        Int(img.size.width * img.scale * img.size.height * img.scale) * 4
    }

    static func cachedThumb(_ sessionId: String, _ name: String, maxPixel: CGFloat) -> UIImage? {
        thumbs.object(forKey: thumbKey(sessionId, name, maxPixel))
    }

    /// Ảnh nhỏ có sẵn trong sự kiện (điện thoại gửi): giải mã một lần rồi nhớ, không giải mã lại mỗi lần vẽ.
    /// Rỗng / hỏng -> nil (nhớ luôn lần hỏng), ô ảnh chuyển sang tải ảnh thật từ máy.
    static func inlineThumb(_ sessionId: String, _ name: String, base64: String) -> UIImage? {
        let key = thumbKey(sessionId, name, 0)
        if let img = thumbs.object(forKey: key) { return img }
        if base64.isEmpty || badThumbs.contains(key as String) { return nil }
        guard let img = ImagePrep.image(base64: base64) else {
            badThumbs.insert(key as String)
            return nil
        }
        thumbs.setObject(img, forKey: key, cost: cost(img))
        return img
    }

    /// Ảnh thu nhỏ (cạnh dài ≤ maxPixel px), giải mã thẳng ở cỡ nhỏ -> không bung cả bitmap gốc.
    static func thumb(_ api: APIClient, _ sessionId: String, _ name: String, maxPixel: CGFloat) async -> UIImage? {
        if let img = cachedThumb(sessionId, name, maxPixel: maxPixel) { return img }
        guard let d = await data(api, sessionId, name) else { return nil }
        guard let img = await Task.detached(priority: .userInitiated, operation: { downsample(d, maxPixel: maxPixel) }).value else { return nil }
        thumbs.setObject(img, forKey: thumbKey(sessionId, name, maxPixel), cost: cost(img))
        return img
    }

    static func full(_ api: APIClient, _ sessionId: String, _ name: String) async -> UIImage? {
        guard let d = await data(api, sessionId, name) else { return nil }
        // preparingForDisplay trả nil với vài định dạng điểm ảnh (PNG 16-bit, xám…) -> dùng ảnh chưa chuẩn bị
        return await Task.detached(priority: .userInitiated) { UIImage(data: d).map { $0.preparingForDisplay() ?? $0 } }.value
    }

    nonisolated private static func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// Khung ô ảnh dùng chung: ảnh phủ kín khung, hoặc vòng quay khi đang tải / biểu tượng ảnh khi lỗi.
private struct ImageTile: View {
    let image: UIImage?
    var loading = false
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if loading {
                ProgressView()
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .frame(width: width, height: height)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// Ảnh trong lời nhắn hoặc kết quả tool; bấm để xem ảnh đầy đủ.
/// Ảnh gửi từ điện thoại có sẵn ảnh nhỏ; ảnh Claude xem trên máy (Read, chụp màn hình…) và ảnh dán trong VS Code
/// thì không -> tải khi hiện ra.
struct EventImages: View {
    let images: [EventImage]
    let sessionId: String
    /// kết quả tool: ô cao 140 giữ tỉ lệ; lời nhắn: ô vuông 72
    var large = false
    @Environment(AppModel.self) private var app
    @State private var shown: UIImage?
    @State private var loading = false
    /// ảnh đang mở: đóng (hoặc mở ảnh khác) trước khi tải xong thì không bật lại
    @State private var opening: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                // cùng một ảnh có thể xuất hiện hai lần (trùng tên) -> định danh theo vị trí
                ForEach(Array(images.enumerated()), id: \.offset) { _, im in
                    Button {
                        Task { await open(im) }
                    } label: {
                        if let t = im.thumb, let thumb = RemoteImages.inlineThumb(sessionId, im.name, base64: t) {
                            ImageTile(image: thumb, width: 72, height: 72)
                        } else {
                            // hàng có thể được dùng lại cho sự kiện khác (nạp lại lịch sử) -> đổi tên là ô mới, không giữ ảnh cũ
                            RemoteImageTile(name: im.name, sessionId: sessionId, large: large).id(im.name)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if loading { ProgressView() }
            }
        }
        .sheet(isPresented: Binding(get: { shown != nil }, set: { if !$0 { shown = nil; opening = nil } })) {
            if let shown { ImageViewer(image: shown, loading: loading) }
        }
    }

    private func open(_ im: EventImage) async {
        guard let api = app.api else { return }
        opening = im.name
        // mở ngay bằng ảnh nhỏ đang có; ảnh đầy đủ (ảnh chụp màn hình vài MB, tải vài giây) xong thì thay vào
        shown = im.thumb.flatMap { RemoteImages.inlineThumb(sessionId, im.name, base64: $0) }
            ?? RemoteImages.cachedThumb(sessionId, im.name, maxPixel: 600)
            ?? RemoteImages.cachedThumb(sessionId, im.name, maxPixel: 216)
        loading = true
        defer { loading = false }
        let full = await RemoteImages.full(api, sessionId, im.name) ?? ImagePrep.image(base64: im.thumb)
        guard opening == im.name, let full else { return }
        shown = full
    }
}

/// Xem ảnh cỡ đầy đủ như app Ảnh: nền đen, mở ra vừa khung, chụm hai ngón để phóng to / thu nhỏ, chạm hai lần để phóng
/// chỗ chạm / trả về vừa khung; vuốt xuống hoặc ✕ để đóng; nút chia sẻ để lưu vào Ảnh / gửi đi.
struct ImageViewer: View {
    let image: UIImage
    /// đang hiện ảnh nhỏ, ảnh đầy đủ còn đang tải
    var loading = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            ZoomableImage(image: image).ignoresSafeArea()
            if loading {
                ProgressView().tint(.white).controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
            }
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark.circle.fill") }
                    .accessibilityLabel("Đóng")
                Spacer()
                ShareLink(item: Image(uiImage: image), preview: SharePreview("Ảnh", image: Image(uiImage: image))) {
                    Image(systemName: "square.and.arrow.up.circle.fill")
                }
                .accessibilityLabel("Lưu / chia sẻ")
            }
            .font(.system(size: 30))
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, Color.white.opacity(0.22))
            .padding(.horizontal, 16)
            .padding(.top, 14)
        }
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }
}

/// UIScrollView phóng to ảnh (SwiftUI chưa có sẵn kiểu phóng to + kéo mượt như app Ảnh).
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> ZoomScrollView { ZoomScrollView(image: image) }
    func updateUIView(_ view: ZoomScrollView, context: Context) { view.setImage(image) }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    private var fittedFor: CGSize = .zero   // khung đã tính mức vừa khung

    init(image: UIImage) {
        super.init(frame: .zero)
        delegate = self
        backgroundColor = .clear
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        decelerationRate = .fast
        contentInsetAdjustmentBehavior = .never
        imageView.contentMode = .scaleAspectFit
        addSubview(imageView)
        let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        addGestureRecognizer(tap)
        setImage(image)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) không dùng") }

    func setImage(_ image: UIImage) {
        guard imageView.image !== image else { return }
        zoomScale = 1
        imageView.image = image
        imageView.frame = CGRect(origin: .zero, size: image.size)
        contentSize = image.size
        fittedFor = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // mở ra (hoặc xoay máy): vừa khung; ảnh nhỏ hơn màn hình thì giữ cỡ thật cho khỏi nhoè
        if bounds.width > 0, bounds.height > 0, bounds.size != fittedFor, let size = imageView.image?.size, size.width > 0, size.height > 0 {
            fittedFor = bounds.size
            let fit = min(bounds.width / size.width, bounds.height / size.height)
            minimumZoomScale = min(fit, 1)
            maximumZoomScale = max(minimumZoomScale * 6, 2)
            zoomScale = minimumZoomScale
        }
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

    // ảnh nhỏ hơn khung (lúc vừa khung / thu nhỏ) thì nằm giữa màn hình
    private func centerImage() {
        let x = max(0, (bounds.width - imageView.frame.width) / 2)
        let y = max(0, (bounds.height - imageView.frame.height) / 2)
        let inset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
        if contentInset != inset { contentInset = inset }
    }

    @objc private func doubleTap(_ g: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale * 1.01 {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let scale = min(maximumZoomScale, minimumZoomScale * 3)
            let p = g.location(in: imageView)
            let w = bounds.width / scale, h = bounds.height / scale
            zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
        }
    }
}

/// Ảnh chưa có ảnh nhỏ sẵn: tải khi hiện ra, bỏ khỏi @State khi cuộn khuất (ảnh nhỏ vẫn còn trong RemoteImages,
/// có giới hạn) -> phiên nhiều ảnh chụp màn hình không làm phình bộ nhớ.
private struct RemoteImageTile: View {
    let name: String
    let sessionId: String
    let large: Bool
    @Environment(AppModel.self) private var app
    @State private var img: UIImage?
    @State private var failed = false

    private var maxPixel: CGFloat { large ? 600 : 216 }
    /// nối được hub và máy tính đang online; đổi thì task chạy lại -> ô lỗi tự tải lại khi có mạng trở lại
    private var reachable: Bool { app.api != nil && app.hub?.connected == true && app.currentMachine?.online != false }

    var body: some View {
        let shown = img ?? RemoteImages.cachedThumb(sessionId, name, maxPixel: maxPixel)
        // ô lớn cao cố định 140, tải xong chỉ đổi chiều rộng -> danh sách không bị đẩy lên xuống
        let w: CGFloat = large ? shown.map { min(max(140 * $0.size.width / max($0.size.height, 1), 60), 260) } ?? 140 : 72
        ImageTile(image: shown, loading: !failed, width: w, height: large ? 140 : 72)
            .task(id: reachable) {
                guard img == nil, reachable, let api = app.api else { return }
                failed = false
                let r = await RemoteImages.thumb(api, sessionId, name, maxPixel: maxPixel)
                guard !Task.isCancelled else { return }   // đã cuộn khuất: không giữ ảnh trong @State
                img = r
                failed = r == nil
            }
            .onDisappear { img = nil }
    }
}
