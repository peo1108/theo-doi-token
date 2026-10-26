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

    /// Ảnh -> {mime, data, name, thumb} gửi cho máy tính (JPEG; cạnh dài ≤ 2000 px trừ khi bật "Gửi ảnh gốc").
    static func payload(_ img: UIImage, index: Int) -> [String: Any]? {
        let full = sendOriginal ? resized(img, maxSide: .greatestFiniteMagnitude) : resized(img, maxSide: maxSide)
        guard let data = full.jpegData(compressionQuality: sendOriginal ? 0.95 : 0.85),
              let thumb = resized(img, maxSide: thumbSide).jpegData(compressionQuality: 0.6) else { return nil }
        return ["mime": "image/jpeg", "data": data.base64EncodedString(), "name": "anh-\(index + 1).jpg", "thumb": thumb.base64EncodedString()]
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

    private static func data(_ api: APIClient, _ sessionId: String, _ name: String) async -> Data? {
        let key = "\(sessionId)/\(name)"
        if let d = blobs.object(forKey: key as NSString) { return d as Data }
        if let t = inflight[key] { return await t.value }
        let t = Task<Data?, Never> {
            guard let r: ImageData = try? await api.call("POST", "/v1/sessions/\(sessionId)/image", body: ["name": name]) else { return nil }
            return Data(base64Encoded: r.data)
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

    static func cachedThumb(_ sessionId: String, _ name: String, maxPixel: CGFloat) -> UIImage? {
        thumbs.object(forKey: thumbKey(sessionId, name, maxPixel))
    }

    /// Ảnh thu nhỏ (cạnh dài ≤ maxPixel px), giải mã thẳng ở cỡ nhỏ -> không bung cả bitmap gốc.
    static func thumb(_ api: APIClient, _ sessionId: String, _ name: String, maxPixel: CGFloat) async -> UIImage? {
        if let img = cachedThumb(sessionId, name, maxPixel: maxPixel) { return img }
        guard let d = await data(api, sessionId, name), let img = downsample(d, maxPixel: maxPixel) else { return nil }
        let px = img.size.width * img.scale * img.size.height * img.scale
        thumbs.setObject(img, forKey: thumbKey(sessionId, name, maxPixel), cost: Int(px) * 4)
        return img
    }

    static func full(_ api: APIClient, _ sessionId: String, _ name: String) async -> UIImage? {
        guard let d = await data(api, sessionId, name) else { return nil }
        return UIImage(data: d)
    }

    private static func downsample(_ data: Data, maxPixel: CGFloat) -> UIImage? {
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

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                // cùng một ảnh có thể xuất hiện hai lần (trùng tên) -> định danh theo vị trí
                ForEach(Array(images.enumerated()), id: \.offset) { _, im in
                    Button {
                        Task { await open(im) }
                    } label: {
                        if let t = im.thumb {
                            ImageTile(image: ImagePrep.image(base64: t), width: 72, height: 72)
                        } else {
                            RemoteImageTile(name: im.name, sessionId: sessionId, large: large)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if loading { ProgressView() }
            }
        }
        .sheet(isPresented: Binding(get: { shown != nil }, set: { if !$0 { shown = nil } })) {
            if let shown {
                ScrollView([.horizontal, .vertical]) { Image(uiImage: shown).resizable().scaledToFit() }
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func open(_ im: EventImage) async {
        guard let api = app.api else { return }
        loading = true
        defer { loading = false }
        shown = await RemoteImages.full(api, sessionId, im.name) ?? ImagePrep.image(base64: im.thumb)
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

    var body: some View {
        let shown = img ?? RemoteImages.cachedThumb(sessionId, name, maxPixel: maxPixel)
        // ô lớn cao cố định 140, tải xong chỉ đổi chiều rộng -> danh sách không bị đẩy lên xuống
        let w: CGFloat = large ? shown.map { min(max(140 * $0.size.width / max($0.size.height, 1), 60), 260) } ?? 140 : 72
        ImageTile(image: shown, loading: !failed, width: w, height: large ? 140 : 72)
            // chạy lại khi có kết nối (app.api từ nil thành có)
            .task(id: "\(name)|\(app.api != nil)") {
                guard img == nil, let api = app.api else { return }
                img = await RemoteImages.thumb(api, sessionId, name, maxPixel: maxPixel)
                failed = img == nil
            }
            .onDisappear { img = nil }
    }
}
