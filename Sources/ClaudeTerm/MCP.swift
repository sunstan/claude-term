import SwiftUI
import AppKit

struct MCPServer: Identifiable, Hashable {
    enum Scope: String { case project = "projet", linked = "lié", local = "local", user = "perso", claudeAI = "claude.ai", plugin = "plugin" }
    enum Health: String { case unknown, connected, needsAuth, failed }

    var name: String
    var transport: String = "stdio"       // stdio | http | sse
    var command: String = ""
    var args: [String] = []
    var url: String = ""
    var env: [String: String] = [:]
    var headers: [String: String] = [:]
    var scope: Scope = .project
    var sourcePath: String = ""           // .mcp.json owning it (project / linked)
    var disabled: Bool = false
    var health: Health = .unknown

    var id: String { scope.rawValue + ":" + name + ":" + sourcePath }
    var editable: Bool { scope == .project || scope == .linked }
    var summary: String { transport == "stdio" ? ([command] + args).joined(separator: " ") : url }

    var json: [String: Any] {
        var o: [String: Any] = [:]
        if transport == "stdio" {
            o["command"] = command
            if !args.isEmpty { o["args"] = args }
        } else {
            o["type"] = transport
            o["url"] = url
            if !headers.isEmpty { o["headers"] = headers }
        }
        if !env.isEmpty { o["env"] = env }
        return o
    }

    static func from(name: String, _ o: [String: Any], scope: Scope, sourcePath: String) -> MCPServer {
        var s = MCPServer(name: name, scope: scope, sourcePath: sourcePath)
        if let u = o["url"] as? String {
            s.url = u
            s.transport = (o["type"] as? String) ?? (u.hasSuffix("/sse") ? "sse" : "http")
        } else {
            s.transport = "stdio"
            s.command = o["command"] as? String ?? ""
            s.args = o["args"] as? [String] ?? []
        }
        s.env = (o["env"] as? [String: Any])?.compactMapValues { "\($0)" } ?? [:]
        s.headers = (o["headers"] as? [String: Any])?.compactMapValues { "\($0)" } ?? [:]
        return s
    }
}

enum MCPStore {
    static let userConfigPath = NSHomeDirectory() + "/.claude.json"

    // MARK: project .mcp.json (read/write)
    static func projectServers(root: String, scope: MCPServer.Scope = .project) -> [MCPServer] {
        let p = root + "/.mcp.json"
        guard let d = FileManager.default.contents(atPath: p),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let servers = o["mcpServers"] as? [String: Any] else { return [] }
        let disabled = Set(disabledInProject(root))
        return servers.keys.sorted().compactMap { n in
            guard let so = servers[n] as? [String: Any] else { return nil }
            var s = MCPServer.from(name: n, so, scope: scope, sourcePath: p)
            s.disabled = disabled.contains(n)
            return s
        }
    }

    /// Rewrites only `mcpServers[name]` in <root>/.mcp.json, keeping everything else.
    static func write(_ server: MCPServer, root: String, replacing oldName: String? = nil) throws {
        let p = root + "/.mcp.json"
        var o: [String: Any] = [:]
        if let d = FileManager.default.contents(atPath: p), !d.isEmpty {
            guard let parsed = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                throw NSError(domain: "ClaudeTerm", code: 10, userInfo: [NSLocalizedDescriptionKey: L(".mcp.json illisible, rien n'a été écrit")])
            }
            o = parsed
        }
        var servers = o["mcpServers"] as? [String: Any] ?? [:]
        if let old = oldName, old != server.name { servers.removeValue(forKey: old) }
        servers[server.name] = server.json
        o["mcpServers"] = servers
        let data = try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: URL(fileURLWithPath: p), options: .atomic)
    }

    static func remove(name: String, root: String) throws {
        let p = root + "/.mcp.json"
        guard let d = FileManager.default.contents(atPath: p),
              var o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              var servers = o["mcpServers"] as? [String: Any] else { return }
        servers.removeValue(forKey: name)
        o["mcpServers"] = servers
        let data = try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: URL(fileURLWithPath: p), options: .atomic)
    }

    // MARK: ~/.claude.json (read only)
    private static func userConfig() -> [String: Any] {
        (FileManager.default.contents(atPath: userConfigPath)).flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
    }
    static func userServers() -> [MCPServer] {
        let servers = userConfig()["mcpServers"] as? [String: Any] ?? [:]
        return servers.keys.sorted().compactMap { n in (servers[n] as? [String: Any]).map { MCPServer.from(name: n, $0, scope: .user, sourcePath: userConfigPath) } }
    }
    static func localServers(root: String) -> [MCPServer] {
        let proj = (userConfig()["projects"] as? [String: Any])?[root] as? [String: Any]
        let servers = proj?["mcpServers"] as? [String: Any] ?? [:]
        return servers.keys.sorted().compactMap { n in (servers[n] as? [String: Any]).map { MCPServer.from(name: n, $0, scope: .local, sourcePath: userConfigPath) } }
    }
    static func disabledInProject(_ root: String) -> [String] {
        let proj = (userConfig()["projects"] as? [String: Any])?[root] as? [String: Any]
        return proj?["disabledMcpjsonServers"] as? [String] ?? []
    }

    /// Servers seen in other projects' .mcp.json, unique by name (to copy them over).
    static func library(excluding root: String?, candidates: [String]) -> [MCPServer] {
        var seen = Set<String>()
        var out: [MCPServer] = []
        for dir in candidates where dir != root {
            for s in projectServers(root: dir) where !seen.contains(s.name) {
                seen.insert(s.name)
                out.append(s)
            }
        }
        return out.sorted { $0.name < $1.name }
    }

    // MARK: claude CLI
    /// Runs `claude mcp <args>` in a login shell, returns (exit, output).
    static func cli(_ args: [String], cwd: String?, completion: @escaping (Int32, String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            let cmd = (["claude", "mcp"] + args).map(shellQuote).joined(separator: " ")
            p.arguments = ["-l", "-c", cmd]
            if let c = cwd { p.currentDirectoryURL = URL(fileURLWithPath: c) }
            let out = Pipe(); p.standardOutput = out; p.standardError = out
            do { try p.run() } catch { DispatchQueue.main.async { completion(-1, error.localizedDescription) }; return }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let s = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { completion(p.terminationStatus, s) }
        }
    }

    /// Parses `claude mcp list` output: "name: target - ✔ Connected" / "! Needs authentication" / "✘ Failed…"
    static func parseList(_ text: String) -> [(name: String, target: String, health: MCPServer.Health)] {
        var out: [(String, String, MCPServer.Health)] = []
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard let sep = line.range(of: " - ", options: .backwards) else { continue }
            // names may contain ":" (plugin:cloudflare:cloudflare); the target starts after the last ": " before " - "
            let head = line[..<sep.lowerBound]
            guard let colon = head.range(of: ": ", options: .backwards) else { continue }
            let name = String(head[..<colon.lowerBound]).trimmingCharacters(in: .whitespaces)
            let target = String(head[colon.upperBound...]).trimmingCharacters(in: .whitespaces)
            let status = String(line[sep.upperBound...])
            let h: MCPServer.Health = status.hasPrefix("✔") ? .connected : (status.contains("auth") ? .needsAuth : .failed)
            out.append((name, target, h))
        }
        return out
    }

    /// CLI args for `claude mcp add` (user / local scopes).
    static func addArgs(_ s: MCPServer, scope: String) -> [String] {
        var a = ["add", "-s", scope, "-t", s.transport]
        for (k, v) in s.env.sorted(by: { $0.key < $1.key }) { a += ["-e", "\(k)=\(v)"] }
        for (k, v) in s.headers.sorted(by: { $0.key < $1.key }) { a += ["-H", "\(k): \(v)"] }
        a.append(s.name)
        if s.transport == "stdio" { a += ["--", s.command] + s.args } else { a.append(s.url) }
        return a
    }
}

// MARK: - rows

struct MCPRow: View {
    let server: MCPServer
    let showScope: Bool
    let onEdit: (() -> Void)?
    let onDelete: (() -> Void)?
    let onCopy: ((MCPServer) -> Void)?
    @EnvironmentObject var state: AppState

    private var healthColor: Color {
        switch server.health { case .connected: return .green; case .needsAuth: return .orange; case .failed: return .red; case .unknown: return .secondary }
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: server.transport == "stdio" ? "terminal" : "network")
                .font(.system(size: 11)).foregroundStyle(server.editable ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(server.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    if showScope { Badge(text: L(server.scope.rawValue), color: .secondary) }
                    if server.disabled { Badge(text: L("désactivé"), color: .orange) }
                    if server.health != .unknown {
                        Badge(text: server.health == .connected ? L("connecté") : (server.health == .needsAuth ? L("auth requise") : L("échec")), color: healthColor)
                    }
                }
                Text(server.summary).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if server.health == .needsAuth {
                Button { state.sendToClaude("/mcp\n") } label: { Text("/mcp").font(.system(size: 10, weight: .semibold)) }
                    .controlSize(.mini).help("Ouvrir le menu MCP de Claude pour s'authentifier")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .contentShape(Rectangle())
        .contextMenu {
            if let e = onEdit { Button("Modifier…") { e() } }
            if let c = onCopy {
                if state.active?.root != nil, server.scope != .project { Button("Copier dans le projet (.mcp.json)") { c(server) } }
            }
            Button("Copier le JSON") {
                let d = try? JSONSerialization.data(withJSONObject: [server.name: server.json], options: [.prettyPrinted, .withoutEscapingSlashes])
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(d.flatMap { String(data: $0, encoding: .utf8) } ?? "", forType: .string)
            }
            if !server.sourcePath.isEmpty {
                Button(String(localized: "Ouvrir \((server.sourcePath as NSString).lastPathComponent)")) { NSWorkspace.shared.open(URL(fileURLWithPath: server.sourcePath)) }
            }
            if let d = onDelete { Divider(); Button("Supprimer…", role: .destructive) { d() } }
        }
    }
}

// MARK: - project panel (left column)

struct ProjectMCPPanel: View {
    @EnvironmentObject var project: Project
    @EnvironmentObject var state: AppState
    @State private var servers: [MCPServer] = []
    @State private var editing: MCPServer?
    @State private var creating = false

    private var library: [MCPServer] {
        MCPStore.library(excluding: project.root, candidates: state.recent + state.projects.compactMap(\.root))
            .filter { l in !servers.contains { $0.name == l.name } }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Menu {
                        Button("Nouveau serveur…") { creating = true }
                        if !library.isEmpty {
                            Divider()
                            Section("Depuis un autre projet") {
                                ForEach(library) { l in Button(l.name + "  ·  " + l.summary) { copy(l) } }
                            }
                        }
                    } label: { Label("Ajouter", systemImage: "plus") }
                    .menuStyle(.borderedButton).fixedSize().controlSize(.small)
                    Spacer()
                    Button { reload() } label: { Image(systemName: "arrow.clockwise") }.controlSize(.small)
                }
                if servers.isEmpty {
                    Text("Aucun serveur MCP dans ce projet.\nIls vivent dans .mcp.json à la racine, partagé avec l'équipe.")
                        .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center).padding(.top, 4)
                } else {
                    VStack(spacing: 0) {
                        ForEach(servers) { s in
                            MCPRow(server: s, showScope: s.scope == .linked,
                                   onEdit: s.scope == .project ? { editing = s } : nil,
                                   onDelete: s.scope == .project ? { delete(s) } : nil,
                                   onCopy: s.scope == .linked ? { copy($0) } : nil)
                            if s.id != servers.last?.id { Divider() }
                        }
                    }
                    .modifier(BorderedBlock())
                }
            }
            .padding(10)
        }
        .onAppear { DispatchQueue.main.async(execute: reload) }
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in reload() }
        .onChange(of: project.links) { _, _ in reload() }
        .sheet(item: $editing) { s in MCPEditSheet(server: s, projectRoot: project.root, onSaved: reload).environmentObject(state) }
        .sheet(isPresented: $creating) { MCPEditSheet(server: nil, projectRoot: project.root, onSaved: reload).environmentObject(state) }
    }

    private func reload() {
        guard let r = project.root else { servers = []; return }
        servers = (MCPStore.projectServers(root: r) + project.links.flatMap { MCPStore.projectServers(root: $0.path, scope: .linked) })
            .map { var s = $0; s.health = state.mcpHealth[$0.name] ?? .unknown; return s }
    }

    private func copy(_ s: MCPServer) {
        guard let r = project.root else { return }
        var c = s; c.scope = .project; c.sourcePath = r + "/.mcp.json"; c.disabled = false; c.health = .unknown
        do { try MCPStore.write(c, root: r) } catch { NSAlert(error: error).runModal() }
        reload()
    }

    private func delete(_ s: MCPServer) {
        guard let r = project.root else { return }
        let a = NSAlert(); a.messageText = String(localized: "Retirer « \(s.name) » de .mcp.json ?"); a.alertStyle = .warning
        a.addButton(withTitle: L("Retirer")); a.addButton(withTitle: L("Annuler"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        do { try MCPStore.remove(name: s.name, root: r) } catch { NSAlert(error: error).runModal() }
        reload()
    }
}

// MARK: - global tab (right panel)

struct GlobalMCPTab: View {
    @EnvironmentObject var state: AppState
    @State private var user: [MCPServer] = []
    @State private var local: [MCPServer] = []
    @State private var remote: [MCPServer] = []      // claude.ai connectors + plugins, from `claude mcp list`
    @State private var checking = false
    @State private var lastCheck: Date?
    @State private var creating = false
    @State private var cliOutput = ""

    private var root: String? { state.active?.root }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { creating = true } label: { Label("Ajouter", systemImage: "plus") }.controlSize(.small)
                Spacer()
                if let d = lastCheck { Text(d.formatted(date: .omitted, time: .shortened)).font(.caption2).foregroundStyle(.tertiary) }
                Button { check() } label: {
                    if checking { ProgressView().controlSize(.mini) } else { Label("Vérifier l'état", systemImage: "heart.text.square") }
                }
                .controlSize(.small).disabled(checking).help("claude mcp list — teste chaque serveur, quelques secondes")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            List {
                Section("Perso · ~/.claude.json") {
                    if user.isEmpty { Text("Aucun serveur perso").foregroundStyle(.secondary).font(.callout) }
                    ForEach(user) { s in MCPRow(server: s, showScope: false, onEdit: nil, onDelete: { removeCLI(s, scope: "user") }, onCopy: copyToProject).listRowInsets(EdgeInsets()) }
                }
                if root != nil {
                    Section("Local · ce projet, privé") {
                        if local.isEmpty { Text("Aucun serveur local").foregroundStyle(.secondary).font(.callout) }
                        ForEach(local) { s in MCPRow(server: s, showScope: false, onEdit: nil, onDelete: { removeCLI(s, scope: "local") }, onCopy: copyToProject).listRowInsets(EdgeInsets()) }
                    }
                }
                Section("claude.ai et plugins") {
                    if remote.isEmpty {
                        Text(lastCheck == nil ? L("Clique « Vérifier l'état » pour les lister") : L("Aucun")).foregroundStyle(.secondary).font(.callout)
                    }
                    ForEach(remote) { s in MCPRow(server: s, showScope: false, onEdit: nil, onDelete: nil, onCopy: nil).listRowInsets(EdgeInsets()) }
                }
                if !cliOutput.isEmpty {
                    Section("Sortie de claude mcp") {
                        Text(cliOutput).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
            .listStyle(.inset).scrollContentBackground(.hidden)
        }
        .onAppear(perform: reload)
        .onChange(of: state.activeId) { _, _ in reload() }
        .sheet(isPresented: $creating) { MCPEditSheet(server: nil, projectRoot: root, defaultScope: "user", onSaved: reload).environmentObject(state) }
    }

    private func reload() {
        user = MCPStore.userServers()
        local = root.map { MCPStore.localServers(root: $0) } ?? []
    }

    private func check() {
        checking = true
        MCPStore.cli(["list"], cwd: root) { code, out in
            checking = false
            lastCheck = Date()
            let parsed = MCPStore.parseList(out)
            cliOutput = code == 0 ? "" : out
            var rem: [MCPServer] = []
            for p in parsed {
                if let i = user.firstIndex(where: { $0.name == p.name }) { user[i].health = p.health }
                else if let i = local.firstIndex(where: { $0.name == p.name }) { local[i].health = p.health }
                else if p.name.hasPrefix("claude.ai ") || p.name.hasPrefix("plugin:") {
                    var s = MCPServer(name: p.name, scope: p.name.hasPrefix("plugin:") ? .plugin : .claudeAI)
                    s.transport = "http"; s.url = p.target; s.health = p.health
                    rem.append(s)
                } else {
                    // project-level server (.mcp.json), not listed here but health is useful
                    state.mcpHealth[p.name] = p.health
                }
            }
            remote = rem
        }
    }

    private func removeCLI(_ s: MCPServer, scope: String) {
        let a = NSAlert(); a.messageText = String(localized: "Retirer « \(s.name) » (\(scope)) ?"); a.alertStyle = .warning
        a.addButton(withTitle: L("Retirer")); a.addButton(withTitle: L("Annuler"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        MCPStore.cli(["remove", "-s", scope, s.name], cwd: root) { code, out in
            cliOutput = code == 0 ? "" : out
            reload()
        }
    }

    private func copyToProject(_ s: MCPServer) {
        guard let r = root else { return }
        var c = s; c.scope = .project; c.sourcePath = r + "/.mcp.json"; c.health = .unknown
        do { try MCPStore.write(c, root: r) } catch { NSAlert(error: error).runModal() }
    }
}

// MARK: - edit sheet

struct MCPEditSheet: View {
    let server: MCPServer?
    let projectRoot: String?
    var defaultScope: String = "project"
    let onSaved: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var transport = "stdio"
    @State private var command = ""
    @State private var url = ""
    @State private var envText = ""
    @State private var headersText = ""
    @State private var scope = "project"
    @State private var error: String?
    @State private var busy = false

    private var isEdit: Bool { server != nil }
    private var valid: Bool {
        !name.isEmpty && name.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.-]*$"#, options: .regularExpression) != nil
            && (transport == "stdio" ? !command.trimmingCharacters(in: .whitespaces).isEmpty : url.hasPrefix("http"))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(isEdit ? L("Modifier le serveur MCP") : L("Nouveau serveur MCP")).font(.title3.weight(.semibold))
            Form {
                TextField("Nom", text: $name, prompt: Text("browsermcp")).disabled(isEdit)
                Picker("Transport", selection: $transport) {
                    Text("Commande (stdio)").tag("stdio"); Text("HTTP").tag("http"); Text("SSE").tag("sse")
                }
                if transport == "stdio" {
                    TextField("Commande", text: $command, prompt: Text("npx @browsermcp/mcp@latest"))
                        .font(.system(size: 12, design: .monospaced))
                } else {
                    TextField("URL", text: $url, prompt: Text("https://…/mcp"))
                        .font(.system(size: 12, design: .monospaced))
                    TextField("En-têtes", text: $headersText, prompt: Text("Authorization: Bearer xxx (un par ligne)"), axis: .vertical)
                        .font(.system(size: 12, design: .monospaced)).lineLimit(1...3)
                }
                TextField("Environnement", text: $envText, prompt: Text("KEY=value (un par ligne)"), axis: .vertical)
                    .font(.system(size: 12, design: .monospaced)).lineLimit(1...4)
                if !isEdit {
                    Picker("Portée", selection: $scope) {
                        if projectRoot != nil { Text("Projet · .mcp.json (partagé)").tag("project") }
                        if projectRoot != nil { Text("Local · ce projet, privé").tag("local") }
                        Text("Perso · tous les projets").tag("user")
                    }
                }
            }
            .formStyle(.columns)
            if let e = error { Text(e).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(isEdit ? L("Enregistrer") : L("Ajouter")) { save() }
                    .buttonStyle(.borderedProminent).disabled(!valid || busy).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
        .onAppear {
            scope = projectRoot == nil ? "user" : defaultScope
            guard let s = server else { return }
            name = s.name; transport = s.transport; url = s.url
            command = ([s.command] + s.args).joined(separator: " ")
            envText = s.env.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "\n")
            headersText = s.headers.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
        }
    }

    private func build() -> MCPServer {
        var s = MCPServer(name: name)
        s.transport = transport
        if transport == "stdio" {
            let parts = command.split(separator: " ").map(String.init)
            s.command = parts.first ?? ""
            s.args = Array(parts.dropFirst())
        } else { s.url = url }
        s.env = pairs(envText, sep: "=")
        s.headers = pairs(headersText, sep: ":")
        return s
    }

    private func pairs(_ text: String, sep: Character) -> [String: String] {
        var out: [String: String] = [:]
        for line in text.split(separator: "\n") {
            guard let i = line.firstIndex(of: sep) else { continue }
            out[line[..<i].trimmingCharacters(in: .whitespaces)] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        return out
    }

    private func save() {
        let s = build()
        if isEdit || scope == "project" {
            guard let r = projectRoot else { return }
            do { try MCPStore.write(s, root: r, replacing: server?.name); onSaved(); dismiss() }
            catch { self.error = error.localizedDescription }
        } else {
            busy = true
            MCPStore.cli(MCPStore.addArgs(s, scope: scope), cwd: projectRoot) { code, out in
                busy = false
                if code == 0 { onSaved(); dismiss() } else { error = out.trimmingCharacters(in: .whitespacesAndNewlines) }
            }
        }
    }
}
