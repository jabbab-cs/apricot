import SwiftUI

@main
struct ApricotApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent)
                .onOpenURL { url in
                    if url.scheme == "apricot" {
                        // Pairing QR code scanned with the iPhone Camera.
                        Task { await model.pair(with: url) }
                    } else {
                        // "Open in Apricot" from Files, Safari downloads or the share sheet.
                        Task { await model.importAPK(from: url) }
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.isConnected {
                HomeView()
            } else {
                ConnectView()
            }
        }
        .overlay(alignment: .top) { BannerView() }
        .animation(.snappy, value: model.isConnected)
    }
}
