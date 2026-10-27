import Foundation
import Observation

/// One live connection to `/ws/stream`: receives video frames and sends touch / key input.
///
/// Frames are received and decoded on a background queue; only state changes hop to the
/// main actor, so decoding never competes with UI touches.
@MainActor
@Observable
final class DeviceStream {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var videoSize: CGSize = .zero
    nonisolated let renderer = H264Renderer()

    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private let session = URLSession(configuration: .default)
    @ObservationIgnored private var target: (api: APIClient, serial: String?)?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var lastError: String?

    /// Bumped on every (re)connect; work from an older connection is dropped.
    @ObservationIgnored nonisolated private let generation = Generation()
    @ObservationIgnored nonisolated private let decodeQueue = DispatchQueue(label: "dev.apricot.decode", qos: .userInteractive)

    init() {
        renderer.onSizeChange = { [weak self] size in
            Task { @MainActor in self?.videoSize = size }
        }
    }

    func connect(api: APIClient, serial: String?) {
        disconnect()
        target = (api, serial)
        open()
    }

    func disconnect() {
        target = nil
        retryTask?.cancel()
        closeSocket()
        phase = .idle
    }

    /// Re-establishes the socket after the app returns to the foreground.
    func reconnect() {
        guard target != nil else { return }
        closeSocket()
        open()
    }

    private func closeSocket() {
        generation.next()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func open() {
        guard let target else { return }
        let gen = generation.next()
        phase = .connecting
        lastError = nil
        let renderer = renderer
        decodeQueue.async { renderer.reset() }

        var query: [URLQueryItem] = []
        if let serial = target.serial { query.append(URLQueryItem(name: "serial", value: serial)) }
        let task = session.webSocketTask(with: target.api.webSocketURL("/ws/stream", query: query))
        task.maximumMessageSize = 32 * 1024 * 1024
        self.task = task
        task.resume()
        Self.receive(task, gen, stream: self)
    }

    private nonisolated static func receive(_ task: URLSessionWebSocketTask, _ gen: Int, stream: DeviceStream) {
        task.receive { [weak stream] result in
            guard let stream, stream.generation.current == gen else { return }
            switch result {
            case .success(.data(let data)):
                stream.decodeQueue.async { stream.decodeFrame(data, gen: gen, task: task) }
                receive(task, gen, stream: stream)
            case .success(.string(let text)):
                Task { @MainActor in stream.handleText(text, gen: gen) }
                receive(task, gen, stream: stream)
            case .success:
                receive(task, gen, stream: stream)
            case .failure(let error):
                Task { @MainActor in
                    guard stream.generation.current == gen else { return }
                    stream.fail(stream.lastError ?? error.localizedDescription)
                }
            }
        }
    }

    /// Runs on `decodeQueue`.
    private nonisolated func decodeFrame(_ data: Data, gen: Int, task: URLSessionWebSocketTask) {
        guard generation.current == gen, data.count > 1 else { return }
        let isKey = data[data.startIndex] & 1 == 1
        if renderer.decode(Data(data.dropFirst()), isKeyFrame: isKey) {
            if generation.markLive(gen) {
                Task { @MainActor in if self.generation.current == gen { self.phase = .live } }
            }
        } else {
            task.send(.string(#"{"type":"keyframe"}"#)) { _ in }
        }
    }

    private func handleText(_ text: String, gen: Int) {
        guard generation.current == gen,
              let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = json["type"] as? String else { return }
        switch type {
        case "error": lastError = json["message"] as? String
        case "closed": lastError = json["reason"] as? String
        default: break
        }
    }

    private func fail(_ message: String) {
        phase = .failed(message)
        task = nil
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.open()
        }
    }

    // MARK: Input

    func send(_ message: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    func touch(_ action: String, id: Int, at point: CGPoint) {
        send(["type": "touch", "action": action, "id": id, "x": point.x, "y": point.y])
    }

    func key(_ name: String) { send(["type": "key", "key": name]) }
    func text(_ text: String) { send(["type": "text", "text": text]) }
    func command(_ type: String) { send(["type": type]) }
}

/// Thread-safe connection counter shared by the main actor and the decode queue.
private final class Generation: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    private var liveFor = -1

    var current: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    @discardableResult
    func next() -> Int {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }

    /// True the first time a frame is shown for this connection.
    func markLive(_ gen: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard gen == value, liveFor != gen else { return false }
        liveFor = gen
        return true
    }
}
