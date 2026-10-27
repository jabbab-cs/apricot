import Foundation
import Observation
import UniformTypeIdentifiers

extension UTType {
    static let apk = UTType(importedAs: "com.android.package-archive")
}

enum AppTab: Hashable {
    case phone, apps, logs, device
}

struct Banner: Identifiable, Equatable {
    let id = UUID()
    let message: String
    let isError: Bool
}

/// App-wide state: the connected server, its status, the APK library and installed apps.
@MainActor
@Observable
final class AppModel {
    private(set) var endpoint: ServerEndpoint?
    private(set) var api: APIClient?
    private(set) var status: ServerStatus?
    private(set) var isConnecting = false
    private(set) var connectionError: String?

    private(set) var library: [LibraryAPK] = []
    private(set) var installed: [InstalledApp] = []
    private(set) var deviceInfo: DeviceInfo?
    private(set) var uploadProgress: Double?
    private(set) var busyIds: Set<String> = []

    var selectedTab: AppTab = .phone
    var banner: Banner?

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private let storeKey = "apricot.endpoint"

    var isConnected: Bool { api != nil && status != nil }
    var selectedSerial: String? { status?.selectedSerial }

    init() {
        if let data = UserDefaults.standard.data(forKey: storeKey),
           let saved = try? JSONDecoder().decode(ServerEndpoint.self, from: data) {
            endpoint = saved
            Task { await connect(to: saved) }
        }
    }

    // MARK: Connection

    func connect(to endpoint: ServerEndpoint) async {
        isConnecting = true
        connectionError = nil
        defer { isConnecting = false }
        let client = APIClient(endpoint: endpoint)
        do {
            let status: ServerStatus = try await client.get("/api/status")
            if status.authRequired, (endpoint.token ?? "").isEmpty {
                throw APIError(message: "This server requires a token. Enter the APRICOT_TOKEN value.")
            }
            self.endpoint = endpoint
            self.api = client
            self.status = status
            UserDefaults.standard.set(try? JSONEncoder().encode(endpoint), forKey: storeKey)
            startPolling()
            await refreshAll()
        } catch {
            self.endpoint = endpoint
            connectionError = error.localizedDescription
        }
    }

    func disconnect() {
        pollTask?.cancel()
        api = nil
        status = nil
        library = []
        installed = []
        deviceInfo = nil
        UserDefaults.standard.removeObject(forKey: storeKey)
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                await self?.refreshStatus()
            }
        }
    }

    func refreshAll() async {
        await refreshStatus()
        await refreshLibrary()
        await refreshInstalled()
        await refreshDeviceInfo()
    }

    func refreshStatus() async {
        guard let api else { return }
        do {
            let previous = status?.selectedSerial
            status = try await api.get("/api/status")
            connectionError = nil
            if status?.selectedSerial != previous {
                await refreshInstalled()
                await refreshDeviceInfo()
            }
        } catch {
            connectionError = error.localizedDescription
        }
    }

    func refreshLibrary() async {
        guard let api else { return }
        if let items: [LibraryAPK] = try? await api.get("/api/apks") { library = items }
    }

    func refreshInstalled() async {
        guard let api, selectedSerial != nil else {
            installed = []
            return
        }
        if let apps: [InstalledApp] = try? await api.get("/api/apps") { installed = apps }
    }

    func refreshDeviceInfo() async {
        guard let api, selectedSerial != nil else {
            deviceInfo = nil
            return
        }
        deviceInfo = try? await api.get("/api/device/info")
    }

    // MARK: Devices

    func select(_ device: AndroidDevice) async {
        await perform { api in
            try await api.send("/api/devices/select", body: ["serial": device.serial])
        }
        await refreshStatus()
    }

    func boot(_ avd: String) async {
        await perform(busyId: "avd:\(avd)") { api in
            try await api.send("/api/avds/boot", body: ["name": avd])
        }
        show("Booting \(avd.replacingOccurrences(of: "_", with: " "))… this takes up to a minute.")
    }

    func press(_ key: String) async {
        await perform { api in try await api.send("/api/device/key", body: ["key": key]) }
    }

    func screenshot() async -> Data? {
        guard let api else { return nil }
        do {
            return try await api.screenshot()
        } catch {
            show(error.localizedDescription, isError: true)
            return nil
        }
    }

    // MARK: Library

    func install(_ apk: LibraryAPK, launch: Bool) async {
        guard selectedSerial != nil else {
            show("Boot a device first (Device tab).", isError: true)
            return
        }
        let ok = await perform(busyId: apk.id) { api in
            try await api.send("/api/apks/\(apk.id)/install", body: ["launch": launch], timeout: 300)
        }
        guard ok else { return }
        show(launch ? "\(apk.label) is running" : "\(apk.label) installed")
        if launch { selectedTab = .phone }
        await refreshInstalled()
    }

    func delete(_ apk: LibraryAPK) async {
        await perform(busyId: apk.id) { api in try await api.send("/api/apks/\(apk.id)", method: "DELETE") }
        await refreshLibrary()
    }

    func run(_ action: AppAction, on app: InstalledApp) async {
        let pkg = app.packageName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? app.packageName
        let ok = await perform(busyId: app.id) { api in
            try await api.send("/api/apps/\(pkg)/\(action.rawValue)")
        }
        guard ok else { return }
        show("\(app.label): \(action.doneMessage)")
        if action == .launch { selectedTab = .phone }
        if action == .uninstall { await refreshInstalled() }
    }

    /// Imports an APK picked in Files or shared to Apricot, uploads it, then installs and launches it.
    func importAPK(from url: URL, autoRun: Bool = true) async {
        guard let api else {
            show("Connect to your computer first, then share the APK again.", isError: true)
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        // Copy to a temp file: the source may be a short-lived inbox or provider URL.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".apk")
        do {
            try FileManager.default.copyItem(at: url, to: tmp)
        } catch {
            show("Couldn't read \(url.lastPathComponent): \(error.localizedDescription)", isError: true)
            return
        }
        defer { try? FileManager.default.removeItem(at: tmp) }

        uploadProgress = 0
        defer { uploadProgress = nil }
        do {
            let apk = try await api.upload(fileURL: tmp, fileName: url.lastPathComponent) { value in
                Task { @MainActor [weak self] in self?.uploadProgress = value }
            }
            await refreshLibrary()
            show("Added \(apk.label)")
            if autoRun, selectedSerial != nil { await install(apk, launch: true) }
        } catch {
            show(error.localizedDescription, isError: true)
        }
    }

    // MARK: Helpers

    func isBusy(_ id: String) -> Bool { busyIds.contains(id) }

    func show(_ message: String, isError: Bool = false) {
        let banner = Banner(message: message, isError: isError)
        self.banner = banner
        Task {
            try? await Task.sleep(for: .seconds(isError ? 5 : 2.5))
            if self.banner == banner { self.banner = nil }
        }
    }

    @discardableResult
    private func perform(busyId: String? = nil, _ work: (APIClient) async throws -> Void) async -> Bool {
        guard let api else { return false }
        if let busyId { busyIds.insert(busyId) }
        defer { if let busyId { busyIds.remove(busyId) } }
        do {
            try await work(api)
            return true
        } catch {
            show(error.localizedDescription, isError: true)
            return false
        }
    }
}
