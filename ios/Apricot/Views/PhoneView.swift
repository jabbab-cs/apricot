import SwiftUI

/// The Android phone: full-bleed live screen, Android navigation bar and device controls.
struct PhoneView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var stream = DeviceStream()
    @State private var keyboardActive = false
    @State private var screenshot: ScreenshotItem?
    @AppStorage("apricot.showNavBar") private var showNavBar = true
    @AppStorage("apricot.immersive") private var immersive = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                ZStack(alignment: .topTrailing) {
                    DeviceScreen(stream: stream, keyboardActive: $keyboardActive)
                    stateOverlay
                    controls
                }
                if showNavBar { navBar }
            }
        }
        .statusBarHidden(immersive)
        .persistentSystemOverlays(immersive ? .hidden : .automatic)
        // In full screen the Android screen reaches the edges, so its own edge swipes win over iOS's.
        .defersSystemGestures(on: immersive ? .all : [])
        .toolbar(immersive ? .hidden : .visible, for: .tabBar)
        .preferredColorScheme(.dark)
        .onAppear(perform: connectIfNeeded)
        .onDisappear {
            keyboardActive = false
            stream.disconnect()
        }
        .onChange(of: model.selectedSerial) { connectIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { stream.reconnect() }
        }
        .sheet(item: $screenshot) { ScreenshotSheet(item: $0) }
    }

    private func connectIfNeeded() {
        guard let api = model.api, let serial = model.selectedSerial else {
            stream.disconnect()
            return
        }
        stream.connect(api: api, serial: serial)
    }

    // MARK: Overlays

    @ViewBuilder
    private var stateOverlay: some View {
        if model.selectedSerial == nil {
            NoDeviceView()
        } else {
            switch stream.phase {
            case .live:
                EmptyView()
            case .idle, .connecting:
                StatusCard(icon: nil, title: "Connecting to \(model.status?.selectedDevice?.model ?? "device")…", detail: nil)
            case .failed(let message):
                StatusCard(icon: "exclamationmark.triangle.fill", title: "Stream interrupted", detail: message) {
                    Button("Retry now", action: connectIfNeeded).buttonStyle(.borderedProminent)
                }
            }
        }
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 8) {
            if stream.phase == .live {
                ControlButton(systemImage: keyboardActive ? "keyboard.chevron.compact.down" : "keyboard") {
                    keyboardActive.toggle()
                }
            }
            Menu {
                Section {
                    Button { stream.command("rotate") } label: { Label("Rotate", systemImage: "rotate.right") }
                    Button { stream.command("notifications") } label: { Label("Notifications", systemImage: "bell") }
                    Button { stream.command("quick-settings") } label: { Label("Quick settings", systemImage: "switch.2") }
                }
                Section {
                    Button { stream.key("volume_up") } label: { Label("Volume up", systemImage: "speaker.plus") }
                    Button { stream.key("volume_down") } label: { Label("Volume down", systemImage: "speaker.minus") }
                    Button { stream.key("power") } label: { Label("Power", systemImage: "power") }
                }
                Section {
                    Button {
                        Task {
                            if let data = await model.screenshot(), let image = UIImage(data: data) {
                                screenshot = ScreenshotItem(image: image)
                            }
                        }
                    } label: { Label("Screenshot", systemImage: "camera.viewfinder") }
                    Toggle(isOn: $showNavBar) { Label("Navigation bar", systemImage: "rectangle.bottomthird.inset.filled") }
                    Toggle(isOn: $immersive.animation()) { Label("Full screen", systemImage: "arrow.up.left.and.arrow.down.right") }
                }
            } label: {
                ControlButton.label(systemImage: "ellipsis")
            }
        }
        .padding(10)
        .opacity(model.selectedSerial == nil ? 0 : 1)
        .allowsHitTesting(model.selectedSerial != nil)
    }

    private var navBar: some View {
        HStack {
            NavKey(systemImage: "arrowtriangle.backward.fill") { stream.key("back") }
            NavKey(systemImage: "circle") { stream.key("home") }
            NavKey(systemImage: "square") { stream.key("recents") }
        }
        .padding(.horizontal, 40)
        .frame(height: 46)
        .background(Color.black)
    }
}

// MARK: - Pieces

private struct ControlButton: View {
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Self.label(systemImage: systemImage) }
    }

    static func label(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(.ultraThinMaterial.opacity(0.9), in: Circle())
            .environment(\.colorScheme, .dark)
    }
}

private struct NavKey: View {
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }
    }
}

private struct StatusCard<Actions: View>: View {
    let icon: String?
    let title: String
    let detail: String?
    @ViewBuilder var actions: Actions

    init(icon: String?, title: String, detail: String?, @ViewBuilder actions: () -> Actions = { EmptyView() }) {
        self.icon = icon
        self.title = title
        self.detail = detail
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 14) {
            if let icon {
                Image(systemName: icon).font(.largeTitle).foregroundStyle(Theme.accent)
            } else {
                ProgressView().controlSize(.large).tint(.white)
            }
            Text(title).font(.headline).foregroundStyle(.white).multilineTextAlignment(.center)
            if let detail {
                Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.6)).multilineTextAlignment(.center)
            }
            actions
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.night)
    }
}

/// Shown when no Android device is running: lists virtual devices that can be booted.
private struct NoDeviceView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 18) {
            Image("Logo").resizable().scaledToFit().frame(width: 64, height: 64)
            Text("No Android device running").font(.title3.weight(.semibold)).foregroundStyle(.white)
            if let tools = model.status?.tools, tools.adb == nil || tools.scrcpyServer == nil {
                Text("Your computer is missing Android tools. Run the Apricot setup script there, then restart the server.")
                    .font(.subheadline).foregroundStyle(.white.opacity(0.6)).multilineTextAlignment(.center)
            } else if let avds = model.status?.avds, !avds.isEmpty {
                Text("Boot a virtual phone on your computer:").font(.subheadline).foregroundStyle(.white.opacity(0.6))
                VStack(spacing: 10) {
                    ForEach(avds, id: \.self) { avd in
                        Button {
                            Task { await model.boot(avd) }
                        } label: {
                            HStack {
                                Image(systemName: "power")
                                Text(avd.replacingOccurrences(of: "_", with: " "))
                                Spacer()
                                if model.isBusy("avd:\(avd)") { ProgressView().tint(.white) }
                            }
                            .font(.body.weight(.semibold))
                            .padding(.horizontal, 18)
                            .padding(.vertical, 14)
                            .frame(maxWidth: 320)
                            .background(Theme.gradient, in: RoundedRectangle(cornerRadius: 14))
                            .foregroundStyle(.white)
                        }
                    }
                }
            } else {
                Text("Create a virtual device in Android Studio, or run the Apricot setup script on your computer.")
                    .font(.subheadline).foregroundStyle(.white.opacity(0.6)).multilineTextAlignment(.center)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.night)
    }
}

struct ScreenshotItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

private struct ScreenshotSheet: View {
    let item: ScreenshotItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Image(uiImage: item.image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .padding()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(uiImage: item.image), preview: SharePreview("Screenshot", image: Image(uiImage: item.image)))
                    }
                }
                .navigationTitle("Screenshot")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}
