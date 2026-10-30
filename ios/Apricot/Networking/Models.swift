import Foundation

/// A paired computer. `urls` comes from its QR code: LAN addresses first, then the remote tunnel.
struct ServerEndpoint: Codable, Hashable {
    var name: String
    var urls: [String]
    var token: String
    /// The address that answered last; tried first next time.
    var active: String?

    var baseURL: URL? { URL(string: active ?? urls.first ?? "") }
    var isRemote: Bool { baseURL?.scheme == "https" }

    /// Parses `apricot://pair?n=<name>&t=<token>&u=<url>&u=<url>`.
    init?(pairingURL: URL) {
        guard pairingURL.scheme == "apricot",
              let items = URLComponents(url: pairingURL, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let urls = items.filter { $0.name == "u" }.compactMap(\.value).filter { URL(string: $0)?.host != nil }
        guard let token = items.first(where: { $0.name == "t" })?.value, !token.isEmpty, !urls.isEmpty else { return nil }
        name = items.first(where: { $0.name == "n" })?.value ?? "Computer"
        self.urls = urls
        self.token = token
    }

    /// Candidates in the order to try them: the last one that worked, then the rest as listed.
    var candidates: [String] {
        guard let active, urls.contains(active) else { return urls }
        return [active] + urls.filter { $0 != active }
    }
}

struct ServerStatus: Decodable {
    struct Tools: Decodable {
        let adb: String?
        let emulator: String?
        let scrcpyServer: String?
        let adbError: String?
    }

    let name: String
    let version: String
    let host: String
    let addresses: [String]
    let port: Int
    let tools: Tools
    let devices: [AndroidDevice]
    let selectedSerial: String?
    let avds: [String]
    let runningAvds: [String]?
    let booting: Bool?
    let remote: String?

    var readyDevices: [AndroidDevice] { devices.filter { $0.state == "device" } }
    var selectedDevice: AndroidDevice? { devices.first { $0.serial == selectedSerial } }
}

struct AndroidDevice: Decodable, Identifiable, Hashable {
    let serial: String
    let state: String
    let model: String
    let isEmulator: Bool
    let selected: Bool
    var id: String { serial }
}

struct DeviceInfo: Decodable {
    let serial: String
    let model: String?
    let androidVersion: String?
    let sdk: Int?
    let abis: [String]
    let screen: String?
    let density: Int?
}

struct LibraryAPK: Decodable, Identifiable, Hashable {
    let id: String
    let packageName: String?
    let label: String
    let versionName: String?
    let versionCode: Int?
    let minSdk: Int?
    let abis: [String]
    let fileName: String
    let size: Int
    let hasIcon: Bool
    let addedAt: String
}

struct InstalledApp: Decodable, Identifiable, Hashable {
    let packageName: String
    let label: String
    let apkId: String?
    let hasIcon: Bool
    let versionName: String?
    var id: String { packageName }
}

struct LogLine: Decodable, Identifiable {
    let id = UUID()
    let time: String
    let pid: Int
    let level: String
    let tag: String
    let message: String

    private enum CodingKeys: String, CodingKey { case time, pid, level, tag, message }
}

enum AppAction: String {
    case launch, stop, clear, uninstall

    var doneMessage: String {
        switch self {
        case .launch: "Opened"
        case .stop: "Stopped"
        case .clear: "Data cleared"
        case .uninstall: "Uninstalled"
        }
    }
}

extension Int {
    var byteString: String { ByteCountFormatter.string(fromByteCount: Int64(self), countStyle: .file) }
}
