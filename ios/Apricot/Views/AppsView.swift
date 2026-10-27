import SwiftUI
import UniformTypeIdentifiers

/// APK manager: the library of uploaded APKs and the apps installed on the device.
struct AppsView: View {
    @Environment(AppModel.self) private var model
    @State private var section: Pane = .library
    @State private var importing = false
    @State private var search = ""

    enum Pane: String, CaseIterable {
        case library = "Library"
        case installed = "Installed"
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("Section", selection: $section) {
                    ForEach(Pane.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                if let progress = model.uploadProgress {
                    ProgressRow(title: progress < 1 ? "Uploading APK…" : "Inspecting APK…", progress: progress)
                }

                switch section {
                case .library: libraryRows
                case .installed: installedRows
                }
            }
            .searchable(text: $search, prompt: section == .library ? "Search library" : "Search installed apps")
            .navigationTitle("Apps")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        importing = true
                    } label: {
                        Label("Add APK", systemImage: "plus.circle.fill")
                    }
                }
            }
            .refreshable {
                await model.refreshLibrary()
                await model.refreshInstalled()
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.apk, .data], allowsMultipleSelection: true) { result in
                guard case let .success(urls) = result else { return }
                Task {
                    for url in urls { await model.importAPK(from: url, autoRun: urls.count == 1) }
                }
            }
            .task { await model.refreshInstalled() }
        }
    }

    // MARK: Library

    private var filteredLibrary: [LibraryAPK] {
        guard !search.isEmpty else { return model.library }
        return model.library.filter {
            $0.label.localizedCaseInsensitiveContains(search) || ($0.packageName ?? "").localizedCaseInsensitiveContains(search)
        }
    }

    @ViewBuilder
    private var libraryRows: some View {
        if model.library.isEmpty {
            ContentUnavailableView {
                Label("No APKs yet", systemImage: "shippingbox")
            } description: {
                Text("Tap + to pick an APK from Files, share one to Apricot from any app, or drop it on the web dashboard on your computer.")
            } actions: {
                Button("Add APK") { importing = true }.buttonStyle(.borderedProminent)
            }
            .listRowBackground(Color.clear)
        } else {
            ForEach(filteredLibrary) { apk in
                LibraryRow(apk: apk)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await model.delete(apk) }
                        } label: { Label("Remove", systemImage: "trash") }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            Task { await model.install(apk, launch: false) }
                        } label: { Label("Install", systemImage: "square.and.arrow.down") }
                            .tint(.blue)
                    }
            }
        }
    }

    // MARK: Installed

    private var filteredInstalled: [InstalledApp] {
        guard !search.isEmpty else { return model.installed }
        return model.installed.filter {
            $0.label.localizedCaseInsensitiveContains(search) || $0.packageName.localizedCaseInsensitiveContains(search)
        }
    }

    @ViewBuilder
    private var installedRows: some View {
        if model.selectedSerial == nil {
            ContentUnavailableView("No device running", systemImage: "iphone.slash", description: Text("Boot a virtual device from the Device tab."))
                .listRowBackground(Color.clear)
        } else if model.installed.isEmpty {
            ContentUnavailableView("No apps installed", systemImage: "square.dashed", description: Text("Run an APK from your library to install it."))
                .listRowBackground(Color.clear)
        } else {
            ForEach(filteredInstalled) { app in
                InstalledRow(app: app)
            }
        }
    }
}

private struct LibraryRow: View {
    @Environment(AppModel.self) private var model
    let apk: LibraryAPK

    var body: some View {
        HStack(spacing: 14) {
            AppIconView(apkId: apk.id, hasIcon: apk.hasIcon, label: apk.label, size: 50)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(apk.label).font(.body.weight(.semibold)).lineLimit(1)
                    if let version = apk.versionName {
                        Text("v\(version)")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(apk.packageName ?? apk.fileName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(details).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if model.isBusy(apk.id) {
                ProgressView()
            } else {
                Button {
                    Task { await model.install(apk, launch: true) }
                } label: {
                    Text("Run")
                        .font(.subheadline.weight(.bold))
                        .padding(.horizontal, 16).padding(.vertical, 7)
                        .background(Theme.gradient, in: Capsule())
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .contextMenu {
            Button { Task { await model.install(apk, launch: true) } } label: { Label("Install & run", systemImage: "play.fill") }
            Button { Task { await model.install(apk, launch: false) } } label: { Label("Install only", systemImage: "square.and.arrow.down") }
            Divider()
            Button(role: .destructive) { Task { await model.delete(apk) } } label: { Label("Remove from library", systemImage: "trash") }
        }
    }

    private var details: String {
        var parts = [apk.size.byteString]
        if let min = apk.minSdk { parts.append("Android API \(min)+") }
        if !apk.abis.isEmpty { parts.append(apk.abis.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

private struct InstalledRow: View {
    @Environment(AppModel.self) private var model
    let app: InstalledApp
    @State private var confirmUninstall = false

    var body: some View {
        Button {
            Task { await model.run(.launch, on: app) }
        } label: {
            HStack(spacing: 14) {
                AppIconView(apkId: app.apkId, hasIcon: app.hasIcon, label: app.label, size: 46)
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.label).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(app.packageName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if model.isBusy(app.id) {
                    ProgressView()
                } else {
                    Image(systemName: "play.circle.fill").font(.title2).foregroundStyle(Theme.accent)
                }
            }
            .padding(.vertical, 3)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { confirmUninstall = true } label: { Label("Uninstall", systemImage: "trash") }
            Button { Task { await model.run(.stop, on: app) } } label: { Label("Stop", systemImage: "stop.fill") }
                .tint(.orange)
        }
        .contextMenu {
            Button { Task { await model.run(.launch, on: app) } } label: { Label("Open", systemImage: "play.fill") }
            Button { Task { await model.run(.stop, on: app) } } label: { Label("Force stop", systemImage: "stop.fill") }
            Button { Task { await model.run(.clear, on: app) } } label: { Label("Clear data", systemImage: "eraser") }
            Divider()
            Button(role: .destructive) { confirmUninstall = true } label: { Label("Uninstall", systemImage: "trash") }
        }
        .confirmationDialog("Uninstall \(app.label)?", isPresented: $confirmUninstall, titleVisibility: .visible) {
            Button("Uninstall", role: .destructive) { Task { await model.run(.uninstall, on: app) } }
        }
    }
}
