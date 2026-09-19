import SwiftUI
import AppKit

struct NpmProject: Identifiable, Equatable {
    let dir: String
    let name: String
    let version: String
    let manager: String          // npm | pnpm | yarn | bun
    let scripts: [(name: String, command: String)]
    var workspaces: [String] = []
    var id: String { dir }
    static func == (a: NpmProject, b: NpmProject) -> Bool { a.dir == b.dir }

    static let favorites = ["dev", "start", "build", "test", "lint", "preview", "typecheck"]

    /// Walks up from `path` to the nearest package.json.
    static func find(from path: String) -> NpmProject? {
        var dir = path
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), !isDir.boolValue {
            dir = (dir as NSString).deletingLastPathComponent
        }
        while dir.count > 1 {
            if let p = load(dir: dir) { return p }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return nil
    }

    static func load(dir: String) -> NpmProject? {
        let fm = FileManager.default
        guard let d = fm.contents(atPath: dir + "/package.json"),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        let scriptsDict = o["scripts"] as? [String: String] ?? [:]
        let sorted = scriptsDict.sorted { a, b in
            let ia = favorites.firstIndex(of: a.key) ?? 99, ib = favorites.firstIndex(of: b.key) ?? 99
            return ia != ib ? ia < ib : a.key < b.key
        }.map { (name: $0.key, command: $0.value) }
        let manager: String
        if fm.fileExists(atPath: dir + "/pnpm-lock.yaml") { manager = "pnpm" }
        else if fm.fileExists(atPath: dir + "/yarn.lock") { manager = "yarn" }
        else if fm.fileExists(atPath: dir + "/bun.lockb") || fm.fileExists(atPath: dir + "/bun.lock") { manager = "bun" }
        else { manager = "npm" }
        var ws: [String] = []
        if let arr = o["workspaces"] as? [String] { ws = arr }
        else if let obj = o["workspaces"] as? [String: Any], let arr = obj["packages"] as? [String] { ws = arr }
        return NpmProject(dir: dir, name: o["name"] as? String ?? (dir as NSString).lastPathComponent,
                          version: o["version"] as? String ?? "", manager: manager, scripts: sorted, workspaces: ws)
    }

    func command(for script: String) -> String {
        manager == "npm" ? "npm run \(script)" : "\(manager) run \(script)"
    }
    var installCommand: String { manager == "npm" ? "npm install" : "\(manager) install" }
}

struct ScriptsPanel: View {
    @EnvironmentObject var project: Project

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    if project.packages.count == 1, let p = project.packages.first {
                        Button { project.runScript(package: p, name: nil) } label: {
                            Label("Installer", systemImage: "arrow.down.circle")
                        }
                        .controlSize(.small).help(p.installCommand)
                    } else {
                        Menu {
                            ForEach(project.packages) { p in
                                Button(p.name) { project.runScript(package: p, name: nil) }
                            }
                        } label: { Label("Installer", systemImage: "arrow.down.circle") }
                        .menuStyle(.borderedButton).fixedSize().controlSize(.small)
                    }
                    Spacer()
                    Button { project.reloadPackages() } label: { Image(systemName: "arrow.clockwise") }
                        .controlSize(.small).help("Relire package.json")
                }
                VStack(spacing: 0) {
                    ForEach(project.packages) { p in
                        PackageCard(package: p, expanded: project.activePackage == p.dir || project.packages.count == 1)
                        if p.dir != project.packages.last?.dir { Divider() }
                    }
                }
                .modifier(BorderedBlock())
            }
            .padding(10)
        }
    }
}

/// One package.json as a card; expanded, it lists its scripts.
struct PackageCard: View {
    let package: NpmProject
    let expanded: Bool
    @EnvironmentObject var project: Project

    private var running: Int {
        project.sessions.filter { s in
            if case .script(let d, _, _) = s.kind, s.alive, s.busy { return d == package.dir }
            return false
        }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                if project.packages.count > 1 {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).frame(width: 12)
                }
                Image(systemName: "shippingbox").font(.system(size: 11)).foregroundStyle(Color.accentColor)
                Text(package.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                if !package.version.isEmpty { Text("v" + package.version).font(.caption2).foregroundStyle(.secondary) }
                Badge(text: package.manager, color: .secondary)
                if running > 0 {
                    Text("\(running)").font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.green.opacity(0.2)).foregroundStyle(.green).clipShape(Capsule())
                }
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .contentShape(Rectangle())
            .onTapGesture { if project.packages.count > 1 { project.activePackage = expanded ? nil : package.dir } }
            .contextMenu {
                Button(package.installCommand) { project.runScript(package: package, name: nil) }
                Button("Ouvrir package.json") { NSWorkspace.shared.open(URL(fileURLWithPath: package.dir + "/package.json")) }
                Button("Afficher dans le Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: package.dir)) }
            }
            if expanded {
                Divider()
                if package.scripts.isEmpty {
                    Text("Aucun script").font(.caption).foregroundStyle(.secondary).padding(8)
                } else {
                    VStack(spacing: 0) {
                        ForEach(package.scripts, id: \.name) { s in
                            ScriptRow(package: package, script: s)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                            if s.name != package.scripts.last?.name { Divider().padding(.leading, 34) }
                        }
                    }
                }
            }
        }
    }
}

private struct ScriptRow: View {
    let package: NpmProject
    let script: (name: String, command: String)
    @EnvironmentObject var project: Project

    private var running: TerminalSession? { project.runningScript(dir: package.dir, name: script.name) }

    var body: some View {
        HStack(spacing: 8) {
            if let r = running {
                Button { project.currentId = r.id } label: {
                    Image(systemName: "stop.circle.fill").font(.system(size: 16)).foregroundStyle(.green)
                }.buttonStyle(.plain).help("En cours · aller à l'onglet")
            } else {
                Button { project.runScript(package: package, name: script.name) } label: {
                    Image(systemName: "play.circle").font(.system(size: 16))
                }.buttonStyle(.plain).foregroundStyle(.tint)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(script.name).font(.system(size: 12, weight: NpmProject.favorites.contains(script.name) ? .semibold : .regular))
                Text(script.command).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
        }
        .contextMenu {
            if let r = running {
                Button("Aller à l'onglet") { project.currentId = r.id }
                Button("Arrêter") { project.close(r) }
            } else {
                Button("Lancer") { project.runScript(package: package, name: script.name) }
            }
            Button("Copier la commande") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(package.command(for: script.name), forType: .string)
            }
            Button("Insérer dans le prompt") {
                if let s = project.current { s.view.send(txt: package.command(for: script.name)) }
            }
        }
    }
}
