import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// HTTP client for the Apricot server running on the user's computer (macOS, Windows or Linux).
final class APIClient: @unchecked Sendable {
    let endpoint: ServerEndpoint
    private let session: URLSession

    init(endpoint: ServerEndpoint) {
        self.endpoint = endpoint
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: URLs

    func url(_ path: String, query: [URLQueryItem] = [], scheme: String = "http") -> URL {
        var c = URLComponents(url: endpoint.url(scheme: scheme)!, resolvingAgainstBaseURL: false)!
        c.path = path
        var items = query
        if let token = endpoint.token, !token.isEmpty { items.append(URLQueryItem(name: "token", value: token)) }
        c.queryItems = items.isEmpty ? nil : items
        return c.url!
    }

    func webSocketURL(_ path: String, query: [URLQueryItem] = []) -> URL {
        url(path, query: query, scheme: "ws")
    }

    func iconURL(apkId: String) -> URL { url("/api/apks/\(apkId)/icon") }

    // MARK: Requests

    private func makeRequest(_ path: String, method: String, body: [String: Any]?, timeout: TimeInterval) throws -> URLRequest {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        req.timeoutInterval = timeout
        if let token = endpoint.token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "No response from server") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            if http.statusCode == 401 { throw APIError(message: "Wrong or missing token for this server.") }
            throw APIError(message: message ?? "Server error \(http.statusCode)")
        }
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        let (data, response) = try await session.data(for: makeRequest(path, method: "GET", body: nil, timeout: 15))
        try check(data, response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    func send(_ path: String, method: String = "POST", body: [String: Any]? = nil, timeout: TimeInterval = 30) async throws -> Data {
        let (data, response) = try await session.data(for: makeRequest(path, method: method, body: body, timeout: timeout))
        try check(data, response)
        return data
    }

    func screenshot() async throws -> Data {
        let (data, response) = try await session.data(for: makeRequest("/api/device/screenshot", method: "GET", body: nil, timeout: 20))
        try check(data, response)
        return data
    }

    func upload(fileURL: URL, fileName: String, progress: @escaping @Sendable (Double) -> Void) async throws -> LibraryAPK {
        var req = try makeRequest("/api/apks", method: "POST", body: nil, timeout: 600)
        req.setValue(fileName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), forHTTPHeaderField: "X-File-Name")
        req.setValue("application/vnd.android.package-archive", forHTTPHeaderField: "Content-Type")
        let delegate = UploadProgressDelegate(progress: progress)
        let (data, response) = try await session.upload(for: req, fromFile: fileURL, delegate: delegate)
        try check(data, response)
        return try JSONDecoder().decode(LibraryAPK.self, from: data)
    }
}

private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let progress: @Sendable (Double) -> Void
    init(progress: @escaping @Sendable (Double) -> Void) { self.progress = progress }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        progress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
