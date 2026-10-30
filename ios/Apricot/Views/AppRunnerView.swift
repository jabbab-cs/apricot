import SwiftUI

/// One Android app, full screen, behaving like an iOS app:
/// swipe up from the bottom edge to close, swipe in from the left edge to go back.
struct AppRunnerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let item: HomeItem

    @State private var stream = DeviceStream()
    @State private var keyboardActive = false
    @State private var launched = false
    @State private var backDrag: CGFloat = 0
    @State private var closeDrag: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            DeviceScreen(stream: stream, keyboardActive: $keyboardActive)
                .ignoresSafeArea(.container, edges: .bottom)
                .scaleEffect(1 - min(closeDrag, 240) / 1200)
            if stream.phase != .live || !launched { splash.transition(.opacity) }
            edgeGestures.ignoresSafeArea(.container, edges: [.bottom, .leading])
        }
        .animation(.easeOut(duration: 0.25), value: stream.phase == .live && launched)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        // Our own edge swipes (back / close) win over iOS's.
        .defersSystemGestures(on: .all)
        .onAppear(perform: start)
        .onDisappear { stream.disconnect() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { stream.reconnect() }
        }
    }

    private func start() {
        guard let api = model.api else { return }
        // Connecting without a serial lets the server start Android if it isn't running yet.
        stream.connect(api: api, serial: model.selectedSerial)
        Task {
            await model.launch(item)
            launched = true
        }
    }

    private func close() {
        stream.key("home")
        keyboardActive = false
        dismiss()
    }

    // MARK: Splash

    private var splash: some View {
        VStack(spacing: 20) {
            AppIcon(item: item, size: 96)
            Text(item.label).font(.title2.weight(.semibold)).foregroundStyle(.white)
            HStack(spacing: 8) {
                ProgressView().tint(.white.opacity(0.7))
                Text(splashText).font(.subheadline).foregroundStyle(.white.opacity(0.65))
            }
            if case .failed(let message) = stream.phase, launched {
                Text(message).font(.footnote).foregroundStyle(.white.opacity(0.5)).multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.night)
        .allowsHitTesting(false)
    }

    private var splashText: String {
        if model.status?.booting == true || model.selectedSerial == nil { return "Starting Android on your computer…" }
        if !item.installed && !launched { return "Installing…" }
        return "Opening…"
    }

    // MARK: Edge gestures

    private var edgeGestures: some View {
        ZStack {
            // Back: swipe in from the left edge, like on Android.
            HStack {
                Color.clear
                    .frame(width: 22)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { backDrag = max(0, $0.translation.width) }
                            .onEnded { value in
                                if value.translation.width > 70 {
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    stream.key("back")
                                }
                                withAnimation(.spring) { backDrag = 0 }
                            }
                    )
                Spacer()
            }
            .overlay(alignment: .leading) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial, in: Circle())
                    .environment(\.colorScheme, .dark)
                    .offset(x: min(backDrag, 90) - 44)
                    .opacity(backDrag > 0 ? Double(min(backDrag / 70, 1)) : 0)
                    .allowsHitTesting(false)
            }

            // Close: swipe up from the home indicator, like any iOS app.
            VStack(spacing: 0) {
                Spacer()
                HStack {
                    Spacer()
                    Button {
                        keyboardActive.toggle()
                    } label: {
                        Image(systemName: keyboardActive ? "keyboard.chevron.compact.down" : "keyboard")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.85))
                            .frame(width: 34, height: 34)
                            .background(.ultraThinMaterial.opacity(0.8), in: Circle())
                            .environment(\.colorScheme, .dark)
                    }
                    .padding(.trailing, 14)
                    .padding(.bottom, 6)
                    .opacity(stream.phase == .live ? 1 : 0)
                }
                Capsule()
                    .fill(.white.opacity(0.85))
                    .frame(width: 134, height: 5)
                    .frame(maxWidth: .infinity)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                    .offset(y: -min(closeDrag, 120) / 4)
                    .gesture(
                        DragGesture(minimumDistance: 4)
                            .onChanged { closeDrag = max(0, -$0.translation.height) }
                            .onEnded { value in
                                if -value.translation.height > 60 || -value.predictedEndTranslation.height > 160 {
                                    close()
                                } else {
                                    withAnimation(.spring) { closeDrag = 0 }
                                }
                            }
                    )
            }
        }
    }
}

/// The whole Android screen (launcher, settings, notifications) with a close button.
struct AndroidScreenView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PhoneView()
            .overlay(alignment: .topLeading) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial.opacity(0.9), in: Circle())
                        .environment(\.colorScheme, .dark)
                }
                .padding(10)
            }
            .task { _ = try? await model.api?.send("/api/start", timeout: 300) }
    }
}
