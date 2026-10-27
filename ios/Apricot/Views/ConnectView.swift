import SwiftUI

/// First screen: find the computer running `npm start` (Bonjour) or enter its address.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var discovery = ServerDiscovery()
    @State private var host = ""
    @State private var port = "7420"
    @State private var token = ""
    @State private var resolving: String?
    @State private var showManual = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    header
                    discovered
                    manual
                    help
                }
                .padding(20)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
        }
        .onAppear {
            discovery.start()
            if let e = model.endpoint {
                host = e.host
                port = String(e.port)
                token = e.token ?? ""
            }
        }
        .onDisappear { discovery.stop() }
    }

    private var header: some View {
        VStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Theme.gradient)
                    .frame(width: 96, height: 96)
                    .shadow(color: Theme.accent.opacity(0.35), radius: 18, y: 8)
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 62, height: 62)
            }
            .padding(.top, 24)
            Text("Apricot")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
            Text("Run your Android apps on this iPhone,\nstreamed from your computer.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var discovered: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Computers on this network").font(.headline)
                Spacer()
                if discovery.isBrowsing { ProgressView().controlSize(.small) }
            }
            if discovery.servers.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "wifi").foregroundStyle(.secondary)
                    Text("Looking for Apricot… make sure the server is running and you're on the same Wi-Fi.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            } else {
                ForEach(discovery.servers) { server in
                    Button {
                        Task { await connect(server) }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "desktopcomputer")
                                .font(.title2)
                                .foregroundStyle(Theme.accent)
                                .frame(width: 36)
                            Text(server.name).font(.body.weight(.semibold)).multilineTextAlignment(.leading)
                            Spacer()
                            if resolving == server.name || (model.isConnecting && resolving == server.name) {
                                ProgressView()
                            } else {
                                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                            }
                        }
                        .padding(16)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .disabled(resolving != nil)
                }
            }
        }
    }

    private var manual: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation { showManual.toggle() }
            } label: {
                HStack {
                    Text("Enter address manually").font(.headline)
                    Spacer()
                    Image(systemName: "chevron.down").rotationEffect(.degrees(showManual ? 180 : 0))
                }
                .foregroundStyle(.primary)
            }
            if showManual || model.connectionError != nil {
                VStack(spacing: 0) {
                    field("Host or IP", text: $host, placeholder: "192.168.1.20", keyboard: .URL)
                    Divider().padding(.leading, 16)
                    field("Port", text: $port, placeholder: "7420", keyboard: .numberPad)
                    Divider().padding(.leading, 16)
                    field("Token", text: $token, placeholder: "optional", keyboard: .default, secure: true)
                }
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))

                if let error = model.connectionError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                Button {
                    Task {
                        await model.connect(to: ServerEndpoint(
                            name: host, host: host.trimmingCharacters(in: .whitespaces),
                            port: Int(port) ?? 7420, token: token.isEmpty ? nil : token
                        ))
                    }
                } label: {
                    Group {
                        if model.isConnecting { ProgressView().tint(.white) } else { Text("Connect") }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.gradient, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(.white)
                }
                .disabled(host.isEmpty || model.isConnecting)
            }
        }
    }

    private var help: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("On your computer").font(.headline)
            Text("1. Run the setup script once: `scripts/setup.sh` (macOS, Linux) or `scripts\\setup-windows.ps1` (Windows).\n2. Start the server: `cd server && npm start`.\n3. Away from home? Use Tailscale and enter the computer's Tailscale IP.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func field(_ title: String, text: Binding<String>, placeholder: String,
                       keyboard: UIKeyboardType, secure: Bool = false) -> some View {
        HStack {
            Text(title).frame(width: 90, alignment: .leading)
            Group {
                if secure { SecureField(placeholder, text: text) } else { TextField(placeholder, text: text) }
            }
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private func connect(_ server: ServerDiscovery.Found) async {
        resolving = server.name
        defer { resolving = nil }
        do {
            let (h, p) = try await ServerDiscovery.resolve(server)
            host = h
            port = String(p)
            await model.connect(to: ServerEndpoint(name: server.name, host: h, port: p, token: token.isEmpty ? nil : token))
            if model.connectionError != nil { showManual = true }
        } catch {
            model.show("Couldn't reach \(server.name): \(error.localizedDescription)", isError: true)
        }
    }
}
