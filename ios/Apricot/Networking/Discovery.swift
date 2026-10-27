import Foundation
import Network
import Observation

/// Finds Apricot servers on the local network via Bonjour (`_apricot._tcp`).
@MainActor
@Observable
final class ServerDiscovery {
    struct Found: Identifiable, Hashable {
        let name: String
        let endpoint: NWEndpoint
        var id: String { name }
    }

    private(set) var servers: [Found] = []
    private(set) var isBrowsing = false
    @ObservationIgnored private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: "_apricot._tcp", domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap { result -> Found? in
                guard case let .service(name, _, _, _) = result.endpoint else { return nil }
                return Found(name: name, endpoint: result.endpoint)
            }
            Task { @MainActor in self?.servers = found.sorted { $0.name < $1.name } }
        }
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                switch state {
                case .ready: self?.isBrowsing = true
                case .failed, .cancelled: self?.isBrowsing = false
                default: break
                }
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
    }

    /// Resolves a Bonjour service to an IPv4 host + port the HTTP client can use.
    nonisolated static func resolve(_ found: Found) async throws -> (host: String, port: Int) {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: found.endpoint, using: params)
        return try await withCheckedThrowingContinuation { continuation in
            let resumed = Resumed()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint, resumed.claim() {
                        var hostString = "\(host)"
                        if let percent = hostString.firstIndex(of: "%") { hostString = String(hostString[..<percent]) }
                        continuation.resume(returning: (hostString, Int(port.rawValue)))
                    }
                    connection.cancel()
                case .failed(let error), .waiting(let error):
                    if resumed.claim() { continuation.resume(throwing: error) }
                    connection.cancel()
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
                if resumed.claim() {
                    continuation.resume(throwing: APIError(message: "Timed out reaching \(found.name)"))
                    connection.cancel()
                }
            }
        }
    }
}

private final class Resumed: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
