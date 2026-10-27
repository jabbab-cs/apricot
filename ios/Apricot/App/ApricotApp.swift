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
                    // "Open in Apricot" from Files, Safari downloads or the share sheet.
                    Task { await model.importAPK(from: url) }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.isConnected {
                MainTabView()
            } else {
                ConnectView()
            }
        }
        .overlay(alignment: .top) { BannerView() }
        .animation(.snappy, value: model.isConnected)
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            PhoneView()
                .tabItem { Label("Phone", systemImage: "iphone.gen3") }
                .tag(AppTab.phone)
            AppsView()
                .tabItem { Label("Apps", systemImage: "square.grid.2x2.fill") }
                .tag(AppTab.apps)
            LogsView()
                .tabItem { Label("Logs", systemImage: "text.alignleft") }
                .tag(AppTab.logs)
            DeviceView()
                .tabItem { Label("Device", systemImage: "gearshape.fill") }
                .tag(AppTab.device)
        }
    }
}
