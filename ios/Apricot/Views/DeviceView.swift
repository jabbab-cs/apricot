import SwiftUI

/// Settings sheet: the computer, Android devices, developer tools.
struct DeviceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let status = model.status {
                    serverSection(status)
                    devicesSection(status)
                    if let info = model.deviceInfo { infoSection(info) }
                    avdSection(status)
                }
                Section("Developer") {
                    NavigationLink { LogsView() } label: { Label("Logs", systemImage: "text.alignleft") }
                    Button {
                        dismiss()
                        model.showAndroid = true
                    } label: { Label("Show whole Android screen", systemImage: "iphone.gen3") }
                }
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await model.refreshAll() }
        }
    }

    private func devicesSection(_ status: ServerStatus) -> some View {
        Section {
            if status.readyDevices.isEmpty {
                Label("No device running", systemImage: "iphone.slash").foregroundStyle(.secondary)
            }
            ForEach(status.readyDevices) { device in
                Button {
                    Task { await model.select(device) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: device.isEmulator ? "iphone.gen3" : "cable.connector")
                            .foregroundStyle(Theme.accent)
                            .frame(width: 28)
                        VStack(alignment: .leading) {
                            Text(device.model).foregroundStyle(.primary)
                            Text(device.serial).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if device.serial == status.selectedSerial {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                    }
                }
            }
        } header: {
            Text("Android devices")
        } footer: {
            Text("Android starts automatically on your computer when you open an app, and stops after a few idle minutes.")
        }
    }

    private func infoSection(_ info: DeviceInfo) -> some View {
        Section("This device") {
            LabeledContent("Model", value: info.model ?? "—")
            LabeledContent("Android", value: "\(info.androidVersion ?? "?") (API \(info.sdk.map(String.init) ?? "?"))")
            LabeledContent("CPU", value: info.abis.joined(separator: ", "))
            if let screen = info.screen {
                LabeledContent("Screen", value: "\(screen)\(info.density.map { " @ \($0) dpi" } ?? "")")
            }
        }
    }

    private func avdSection(_ status: ServerStatus) -> some View {
        Section {
            if status.avds.isEmpty {
                Text("No virtual devices found. Run the Apricot setup script or create one in Android Studio.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(status.avds, id: \.self) { avd in
                HStack {
                    Label(avd.replacingOccurrences(of: "_", with: " "), systemImage: "externaldrive.connected.to.line.below")
                    Spacer()
                    if status.runningAvds?.contains(avd) == true {
                        Text("Running").font(.subheadline).foregroundStyle(.green)
                    } else if model.isBusy("avd:\(avd)") {
                        ProgressView()
                    } else {
                        Button("Boot") { Task { await model.boot(avd) } }
                            .buttonStyle(.bordered)
                    }
                }
            }
        } header: {
            Text("Virtual devices")
        }
    }

    private func serverSection(_ status: ServerStatus) -> some View {
        Section {
            LabeledContent("Computer", value: status.host)
            LabeledContent("Connected via", value: model.endpoint?.isRemote == true ? "Internet" : "Local network")
            LabeledContent("Version", value: status.version)
            LabeledContent("scrcpy-server", value: status.tools.scrcpyServer.map { "v\($0)" } ?? "missing")
            if let error = model.connectionError {
                Label(error, systemImage: "wifi.exclamationmark").foregroundStyle(.red).font(.footnote)
            }
            Button("Unpair this computer", role: .destructive) {
                dismiss()
                model.disconnect()
            }
        } header: {
            Text("Computer")
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Apricot", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
            Link(destination: URL(string: "https://github.com/Genymobile/scrcpy")!) {
                Label("Streaming powered by scrcpy (Apache-2.0)", systemImage: "heart")
            }
        } header: {
            Text("About")
        }
    }
}
