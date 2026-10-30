import SwiftUI

/// First screen: pair with the computer by scanning the QR code it shows.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 18) {
                ZStack {
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .fill(Theme.gradient)
                        .frame(width: 112, height: 112)
                        .shadow(color: Theme.accent.opacity(0.4), radius: 24, y: 10)
                    Image("Logo").resizable().scaledToFit().frame(width: 72, height: 72)
                }
                Text("Apricot")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                Text("Your Android apps, on your iPhone.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                step(1, "On your computer, run **./apricot**", "Windows: double-click apricot.cmd")
                step(2, "Scan the QR code it shows", "Works at home or away, on Wi-Fi or cellular")
            }
            .padding(.horizontal, 28)
            Spacer()
            if let error = model.connectionError, model.endpoint != nil {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 12)
            }
            VStack(spacing: 12) {
                Button { scanning = true } label: {
                    HStack {
                        if model.isConnecting { ProgressView().tint(.white) } else { Image(systemName: "qrcode.viewfinder") }
                        Text(model.isConnecting ? "Connecting…" : "Scan QR code")
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 17)
                    .background(Theme.gradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .foregroundStyle(.white)
                }
                .disabled(model.isConnecting)
                if let endpoint = model.endpoint {
                    Button("Reconnect to \(endpoint.name)") { Task { await model.connect(to: endpoint) } }
                        .font(.subheadline.weight(.semibold))
                        .disabled(model.isConnecting)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
        .fullScreenCover(isPresented: $scanning) { ScanSheet() }
    }

    private func step(_ n: Int, _ title: LocalizedStringKey, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(n)")
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(Theme.accent)
                .frame(width: 28, height: 28)
                .background(Theme.accent.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}
