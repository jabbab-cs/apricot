import SwiftUI

enum Theme {
    static let accent = Color(red: 1.0, green: 0.478, blue: 0.271)
    static let accentLight = Color(red: 1.0, green: 0.706, blue: 0.369)
    static let gradient = LinearGradient(colors: [accentLight, accent], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let night = Color(red: 0.07, green: 0.066, blue: 0.062)
}

/// App icon from the server, falling back to a monogram tile.
struct AppIconView: View {
    @Environment(AppModel.self) private var model
    let apkId: String?
    let hasIcon: Bool
    let label: String
    var size: CGFloat = 48

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        Group {
            if hasIcon, let apkId, let url = model.api?.iconURL(apkId: apkId) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        monogram
                    }
                }
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(.primary.opacity(0.06)))
    }

    private var monogram: some View {
        ZStack {
            Theme.gradient.opacity(0.18)
            Text(String(label.prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.accent)
        }
    }
}

struct BannerView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let banner = model.banner {
            HStack(spacing: 10) {
                Image(systemName: banner.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(banner.isError ? .red : .green)
                Text(banner.message)
                    .font(.subheadline.weight(.medium))
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .id(banner.id)
            .onTapGesture { model.banner = nil }
        }
    }
}

struct ProgressRow: View {
    let title: String
    let progress: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.medium))
            ProgressView(value: progress).tint(Theme.accent)
        }
        .padding(.vertical, 4)
    }
}
