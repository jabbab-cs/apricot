import SwiftUI

/// The home screen: every Android app as an icon, iOS style. Tap one to open it full screen.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var zoom
    @State private var importing = false
    @State private var showSettings = false

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: 4)

    var body: some View {
        @Bindable var model = model
        ZStack(alignment: .bottom) {
            Wallpaper()
            ScrollView {
                header
                if model.homeItems.isEmpty, model.uploadProgress == nil {
                    emptyState
                } else {
                    LazyVGrid(columns: columns, spacing: 22) {
                        ForEach(model.homeItems) { item in
                            AppTile(item: item, namespace: zoom)
                        }
                        if let progress = model.uploadProgress { UploadTile(progress: progress) }
                    }
                    .padding(.horizontal, 18)
                }
                Color.clear.frame(height: 120)
            }
            .scrollIndicators(.hidden)
            .refreshable { await model.refreshAll() }
            dock
        }
        .preferredColorScheme(.dark)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.apk, .data], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            Task { for url in urls { await model.importAPK(from: url, autoRun: urls.count == 1) } }
        }
        .sheet(isPresented: $showSettings) { DeviceView() }
        .fullScreenCover(item: $model.openApp) { item in
            AppRunnerView(item: item).zoomTransition(id: item.id, in: zoom)
        }
        .fullScreenCover(isPresented: $model.showAndroid) { AndroidScreenView() }
        .task { await model.refreshAll() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.connectionError == nil ? .green : .orange)
                .frame(width: 8, height: 8)
            Text(model.status?.host ?? model.endpoint?.name ?? "")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if model.endpoint?.isRemote == true {
                Image(systemName: "globe").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .foregroundStyle(.white.opacity(0.9))
        .padding(.horizontal, 24)
        .padding(.top, 14)
        .padding(.bottom, 26)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.white.opacity(0.7))
            Text("No apps yet").font(.title3.weight(.semibold))
            Text("Tap **Add APK** below, or share an .apk file to Apricot from Files, Safari or Mail.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(40)
        .padding(.top, 60)
    }

    private var dock: some View {
        HStack(spacing: 0) {
            DockButton(title: "Android", systemImage: "apps.iphone", colors: [.green, .mint]) { model.showAndroid = true }
            DockButton(title: "Add APK", systemImage: "plus", colors: [Theme.accentLight, Theme.accent]) { importing = true }
            DockButton(title: "Settings", systemImage: "gearshape.fill", colors: [.gray, Color(white: 0.35)]) { showSettings = true }
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 34, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}

// MARK: - Pieces

private struct Wallpaper: View {
    var body: some View {
        LinearGradient(
            colors: [Color(red: 0.98, green: 0.55, blue: 0.33), Color(red: 0.55, green: 0.2, blue: 0.35), Color(red: 0.1, green: 0.07, blue: 0.2)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
        .overlay(
            RadialGradient(colors: [.white.opacity(0.25), .clear], center: .topTrailing, startRadius: 10, endRadius: 420)
        )
        .ignoresSafeArea()
    }
}

private struct AppTile: View {
    @Environment(AppModel.self) private var model
    let item: HomeItem
    let namespace: Namespace.ID
    @State private var confirmUninstall = false

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            model.openApp = item
        } label: {
            VStack(spacing: 6) {
                AppIcon(item: item, size: 62)
                    .overlay(alignment: .topTrailing) {
                        if !item.installed {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.system(size: 18))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .blue)
                                .offset(x: 6, y: -6)
                        }
                    }
                    .overlay { if model.isBusy(item.id) { ProgressView().tint(.white) } }
                    .zoomSource(id: item.id, in: namespace)
                Text(item.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
                    .lineLimit(1)
            }
        }
        .buttonStyle(PressableStyle())
        .contextMenu { menu } preview: {
            VStack(spacing: 10) {
                AppIcon(item: item, size: 84)
                Text(item.label).font(.headline)
                if let v = item.apk?.versionName { Text("Version \(v)").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(24)
        }
        .confirmationDialog("Uninstall \(item.label)?", isPresented: $confirmUninstall, titleVisibility: .visible) {
            Button("Uninstall", role: .destructive) {
                if let app = model.installedApp(for: item) { Task { await model.run(.uninstall, on: app) } }
            }
        } message: {
            Text("Its data on the Android device is deleted too.")
        }
    }

    @ViewBuilder
    private var menu: some View {
        Button { model.openApp = item } label: { Label("Open", systemImage: "arrow.up.forward.app") }
        if let app = model.installedApp(for: item) {
            Button { Task { await model.run(.stop, on: app) } } label: { Label("Force stop", systemImage: "stop.circle") }
            Button { Task { await model.run(.clear, on: app) } } label: { Label("Clear data", systemImage: "eraser") }
            Button(role: .destructive) { confirmUninstall = true } label: { Label("Uninstall", systemImage: "trash") }
        }
        if let apk = item.apk, !item.installed {
            Button(role: .destructive) { Task { await model.delete(apk) } } label: { Label("Remove", systemImage: "trash") }
        }
    }
}

/// App icon from the server (extracted from the APK), or a monogram while it loads.
struct AppIcon: View {
    @Environment(AppModel.self) private var model
    let item: HomeItem
    var size: CGFloat = 62

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
        AsyncImage(url: iconURL) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                monogram
            }
        }
        .frame(width: size, height: size)
        .background(.white)
        .clipShape(shape)
        .shadow(color: .black.opacity(0.18), radius: 4, y: 2)
    }

    private var iconURL: URL? {
        guard let api = model.api else { return nil }
        if let pkg = item.packageName { return api.iconURL(package: pkg) }
        if let apk = item.apk, apk.hasIcon { return api.iconURL(apkId: apk.id) }
        return nil
    }

    private var monogram: some View {
        ZStack {
            Theme.gradient
            Text(String(item.label.prefix(1)).uppercased())
                .font(.system(size: size * 0.44, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }
}

private struct UploadTile: View {
    let progress: Double

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.ultraThinMaterial)
                Circle().stroke(.white.opacity(0.25), lineWidth: 4).frame(width: 30)
                Circle().trim(from: 0, to: progress).stroke(.white, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 30)
            }
            .frame(width: 62, height: 62)
            Text(progress < 1 ? "Uploading…" : "Installing…")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
        }
    }
}

private struct DockButton: View {
    let title: String
    let systemImage: String
    let colors: [Color]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(
                        LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )
                Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.9))
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(PressableStyle())
    }
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .brightness(configuration.isPressed ? -0.08 : 0)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Zoom transition (iOS 18+, a plain cover on iOS 17)

extension View {
    @ViewBuilder
    func zoomSource(id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18.0, *) {
            matchedTransitionSource(id: id, in: namespace) { $0.clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)) }
        } else {
            self
        }
    }

    @ViewBuilder
    func zoomTransition(id: String, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18.0, *) {
            navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            self
        }
    }
}
