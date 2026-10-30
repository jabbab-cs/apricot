import SwiftUI

/// Live `adb logcat`, optionally filtered to one app from the library.
struct LogsView: View {
    @Environment(AppModel.self) private var model
    @State private var logcat = LogcatStream()
    @State private var package: String = ""
    @State private var level = "I"
    @State private var search = ""

    private let levels = [("V", "Verbose"), ("D", "Debug"), ("I", "Info"), ("W", "Warn"), ("E", "Error")]

    var body: some View {
            Group {
                if model.selectedSerial == nil {
                    ContentUnavailableView("No device running", systemImage: "text.alignleft", description: Text("Logs appear here once a device is running."))
                } else {
                    logList
                }
            }
            .navigationTitle("Logs")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Filter tag or message")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("App", selection: $package) {
                            Text("All processes").tag("")
                            ForEach(packages, id: \.self) { Text($0).tag($0) }
                        }
                        Picker("Level", selection: $level) {
                            ForEach(levels, id: \.0) { Text($0.1).tag($0.0) }
                        }
                    } label: {
                        Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { logcat.paused.toggle() } label: {
                        Image(systemName: logcat.paused ? "play.fill" : "pause.fill")
                    }
                    Button { logcat.clear() } label: { Image(systemName: "trash") }
                }
            }
        .onAppear(perform: restart)
        .onDisappear { logcat.stop() }
        .onChange(of: package) { restart() }
        .onChange(of: level) { restart() }
        .onChange(of: model.selectedSerial) { restart() }
    }

    private var packages: [String] {
        Array(Set(model.library.compactMap(\.packageName))).sorted()
    }

    private var visibleLines: [LogLine] {
        guard !search.isEmpty else { return logcat.lines }
        return logcat.lines.filter { $0.tag.localizedCaseInsensitiveContains(search) || $0.message.localizedCaseInsensitiveContains(search) }
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(visibleLines) { line in
                        LogRow(line: line).id(line.id)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .background(Color(red: 0.06, green: 0.055, blue: 0.05))
            .onChange(of: logcat.lines.count) {
                guard !logcat.paused, let last = visibleLines.last else { return }
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }

    private func restart() {
        guard let api = model.api, model.selectedSerial != nil else {
            logcat.stop()
            return
        }
        logcat.start(api: api, package: package.isEmpty ? nil : package, level: level)
    }
}

private struct LogRow: View {
    let line: LogLine

    var body: some View {
        (Text(line.time.split(separator: " ").last.map(String.init) ?? line.time).foregroundColor(.white.opacity(0.35))
            + Text(" \(line.level) ").foregroundColor(color)
            + Text(line.tag).foregroundColor(Theme.accentLight)
            + Text(" \(line.message)").foregroundColor(color))
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var color: Color {
        switch line.level {
        case "E", "F", "A": Color(red: 1, green: 0.48, blue: 0.45)
        case "W": Color(red: 0.96, green: 0.76, blue: 0.42)
        case "V", "D": .white.opacity(0.55)
        default: .white.opacity(0.88)
        }
    }
}

@MainActor
@Observable
final class LogcatStream {
    private(set) var lines: [LogLine] = []
    var paused = false
    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var generation = 0
    private let maxLines = 2_000

    private struct Batch: Decodable {
        let type: String
        let lines: [LogLine]?
    }

    func start(api: APIClient, package: String?, level: String) {
        stop()
        lines = []
        generation += 1
        let gen = generation
        var query = [URLQueryItem(name: "level", value: level)]
        if let package { query.append(URLQueryItem(name: "package", value: package)) }
        let task = URLSession.shared.webSocketTask(with: api.webSocketURL("/ws/logcat", query: query))
        self.task = task
        task.resume()
        receive(task, gen)
    }

    func stop() {
        generation += 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    func clear() { lines = [] }

    private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation, case let .success(message) = result else { return }
                if case let .string(text) = message,
                   let batch = try? JSONDecoder().decode(Batch.self, from: Data(text.utf8)),
                   let new = batch.lines, !self.paused {
                    self.lines.append(contentsOf: new)
                    if self.lines.count > self.maxLines { self.lines.removeFirst(self.lines.count - self.maxLines) }
                }
                self.receive(task, gen)
            }
        }
    }
}
