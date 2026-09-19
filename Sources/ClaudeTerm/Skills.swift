import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct SkillInfo: Identifiable, Hashable {
    enum Source: String { case project = "projet", linked = "lié", personal = "perso", plugin = "plugin" }
    let name: String            // slash name, e.g. "release-notes" or "cloudflare:wrangler"
    let description: String
    let path: String            // SKILL.md or command .md
    let source: Source
    let isCommand: Bool         // legacy .claude/commands/*.md
    var manualOnly: Bool = false      // disable-model-invocation: true → only via /name
    var autoOnly: Bool = false        // user-invocable: false → never via /name
    var id: String { path }
    /// "auto" (Claude picks it), "manuel" (/name only), "les deux"
    var modeLabel: String { manualOnly || isCommand ? L("manuel") : (autoOnly ? L("auto") : "auto + /") }
    var editable: Bool { source != .plugin }
    var dir: String { (path as NSString).deletingLastPathComponent }
}

enum SkillStore {
    static let personalSkills = NSHomeDirectory() + "/.claude/skills"
    static let personalCommands = NSHomeDirectory() + "/.claude/commands"
    static let pluginsCache = NSHomeDirectory() + "/.claude/plugins/cache"

    static func projectSkills(root: String, source: SkillInfo.Source = .project) -> [SkillInfo] {
        skills(in: root + "/.claude/skills", source: source) + commands(in: root + "/.claude/commands", source: source)
    }

    static func personal() -> [SkillInfo] {
        skills(in: personalSkills, source: .personal) + commands(in: personalCommands, source: .personal)
    }

    /// Plugin skills: <cache>/<marketplace>/<plugin>/**/skills/<name>/SKILL.md → "plugin:name"
    static func plugins() -> [SkillInfo] {
        let fm = FileManager.default
        guard let e = fm.enumerator(atPath: pluginsCache) else { return [] }
        var out: [SkillInfo] = []
        while let rel = e.nextObject() as? String {
            if e.level > 8 { e.skipDescendants(); continue }
            guard rel.hasSuffix("/SKILL.md"), rel.contains("/skills/") else { continue }
            let path = pluginsCache + "/" + rel
            let parts = rel.split(separator: "/").map(String.init)
            let plugin = parts.count > 1 ? parts[1] : "plugin"
            let fm_ = frontmatter(path)
            let name = fm_["name"] ?? (path as NSString).deletingLastPathComponent.split(separator: "/").last.map(String.init) ?? "?"
            out.append(SkillInfo(name: "\(plugin):\(name)", description: fm_["description"] ?? "", path: path, source: .plugin, isCommand: false,
                                 manualOnly: fm_["disable-model-invocation"] == "true", autoOnly: fm_["user-invocable"] == "false"))
        }
        return out.sorted { $0.name < $1.name }
    }

    private static func skills(in dir: String, source: SkillInfo.Source) -> [SkillInfo] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        return names.compactMap { n -> SkillInfo? in
            let p = dir + "/" + n + "/SKILL.md"
            guard fm.fileExists(atPath: p) else { return nil }
            let f = frontmatter(p)
            return SkillInfo(name: f["name"] ?? n, description: f["description"] ?? "", path: p, source: source, isCommand: false,
                             manualOnly: f["disable-model-invocation"] == "true", autoOnly: f["user-invocable"] == "false")
        }.sorted { $0.name < $1.name }
    }

    private static func commands(in dir: String, source: SkillInfo.Source) -> [SkillInfo] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        return names.filter { $0.hasSuffix(".md") }.map { n in
            let p = dir + "/" + n
            let f = frontmatter(p)
            return SkillInfo(name: String(n.dropLast(3)), description: f["description"] ?? firstLine(p), path: p, source: source, isCommand: true)
        }.sorted { $0.name < $1.name }
    }

    static func frontmatter(_ path: String) -> [String: String] {
        guard let s = try? String(contentsOfFile: path, encoding: .utf8), s.hasPrefix("---") else { return [:] }
        var out: [String: String] = [:]
        for line in s.split(separator: "\n", omittingEmptySubsequences: false).dropFirst() {
            if line.hasPrefix("---") { break }
            guard let c = line.firstIndex(of: ":") else { continue }
            let k = line[..<c].trimmingCharacters(in: .whitespaces)
            var v = line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
            if v.count >= 2, (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) { v = String(v.dropFirst().dropLast()) }
            out[k] = v
        }
        return out
    }

    private static func firstLine(_ path: String) -> String {
        ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "")
            .split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !$0.hasPrefix("#") }
            .map(String.init) ?? ""
    }

    static func isValidName(_ n: String) -> Bool {
        n.range(of: #"^[a-z0-9]+(-[a-z0-9]+)*$"#, options: .regularExpression) != nil
    }

    /// Creates <base>/.claude/skills/<name>/SKILL.md (or ~/.claude/skills/<name>) with a frontmatter skeleton.
    @discardableResult
    static func create(name: String, description: String, projectRoot: String?, extra: String? = nil) throws -> String {
        let base = projectRoot.map { $0 + "/.claude/skills" } ?? personalSkills
        let dir = base + "/" + name
        let path = dir + "/SKILL.md"
        guard !FileManager.default.fileExists(atPath: path) else {
            throw NSError(domain: "ClaudeTerm", code: 2, userInfo: [NSLocalizedDescriptionKey: String(localized: "Le skill « \(name) » existe déjà")])
        }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let body = """
        ---
        name: \(name)
        description: \(description)
        \(extra.map { $0 + "\n" } ?? "")---

        # \(name)

        <!-- Instructions pour Claude : quand utiliser cette skill, étapes, contraintes. -->

        """
        try body.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }

    /// Imports a .md file or a folder containing SKILL.md as a skill. Returns the created SKILL.md path.
    @discardableResult
    static func importSkill(from url: URL, projectRoot: String?) throws -> String {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        fm.fileExists(atPath: url.path, isDirectory: &isDir)
        let base = projectRoot.map { $0 + "/.claude/skills" } ?? personalSkills
        try fm.createDirectory(atPath: base, withIntermediateDirectories: true)
        if isDir.boolValue {
            guard fm.fileExists(atPath: url.path + "/SKILL.md") else {
                throw NSError(domain: "ClaudeTerm", code: 3, userInfo: [NSLocalizedDescriptionKey: L("Ce dossier ne contient pas de SKILL.md")])
            }
            let name = frontmatter(url.path + "/SKILL.md")["name"] ?? url.lastPathComponent
            let dest = base + "/" + name
            guard !fm.fileExists(atPath: dest) else { throw exists(name) }
            try fm.copyItem(atPath: url.path, toPath: dest)
            return dest + "/SKILL.md"
        }
        guard url.pathExtension.lowercased() == "md" else {
            throw NSError(domain: "ClaudeTerm", code: 4, userInfo: [NSLocalizedDescriptionKey: L("Un skill est un fichier .md ou un dossier avec SKILL.md")])
        }
        let fmv = frontmatter(url.path)
        let rawName = fmv["name"] ?? url.deletingPathExtension().lastPathComponent
        let name = rawName.lowercased().replacingOccurrences(of: " ", with: "-").filter { $0.isLetter || $0.isNumber || $0 == "-" }
        let dir = base + "/" + name
        guard !fm.fileExists(atPath: dir) else { throw exists(name) }
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var body = try String(contentsOf: url, encoding: .utf8)
        if !body.hasPrefix("---") {
            // add the frontmatter Claude Code expects
            body = "---\nname: \(name)\ndescription: \(name)\n---\n\n" + body
        } else if fmv["name"] == nil {
            body = body.replacingOccurrences(of: "---\n", with: "---\nname: \(name)\n", options: [], range: body.range(of: "---\n"))
        }
        try body.write(toFile: dir + "/SKILL.md", atomically: true, encoding: .utf8)
        return dir + "/SKILL.md"
    }

    private static func exists(_ name: String) -> NSError {
        NSError(domain: "ClaudeTerm", code: 2, userInfo: [NSLocalizedDescriptionKey: String(localized: "Le skill « \(name) » existe déjà")])
    }

    static func duplicate(_ s: SkillInfo, toProjectRoot root: String?) throws {
        let fm = FileManager.default
        if s.isCommand {
            let base = root.map { $0 + "/.claude/commands" } ?? personalCommands
            try fm.createDirectory(atPath: base, withIntermediateDirectories: true)
            try fm.copyItem(atPath: s.path, toPath: base + "/" + (s.path as NSString).lastPathComponent)
        } else {
            let base = root.map { $0 + "/.claude/skills" } ?? personalSkills
            try fm.createDirectory(atPath: base, withIntermediateDirectories: true)
            try fm.copyItem(atPath: s.dir, toPath: base + "/" + (s.dir as NSString).lastPathComponent)
        }
    }

    static func trash(_ s: SkillInfo) throws {
        try FileManager.default.trashItem(at: URL(fileURLWithPath: s.isCommand ? s.path : s.dir), resultingItemURL: nil)
    }
}

// MARK: - shared row

struct SkillRow: View {
    let skill: SkillInfo
    let showSource: Bool
    let onRefresh: () -> Void
    @EnvironmentObject var state: AppState
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: skill.isCommand || skill.manualOnly ? "slash.circle" : (skill.autoOnly ? "wand.and.stars" : "sparkle"))
                .font(.system(size: 11)).foregroundStyle(skill.editable ? Color.accentColor : Color.secondary)
                .help(skill.isCommand || skill.manualOnly ? L("Invocation manuelle uniquement (/nom)") : (skill.autoOnly ? L("Chargé automatiquement par Claude, pas de /nom") : L("Automatique, ou /nom")))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text((skill.autoOnly ? "" : "/") + skill.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Badge(text: skill.modeLabel, color: skill.isCommand || skill.manualOnly ? .orange : (skill.autoOnly ? .purple : .secondary))
                    if showSource { Badge(text: L(skill.source.rawValue), color: .secondary) }
                }
                if !skill.description.isEmpty {
                    Text(skill.description).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if !skill.autoOnly {
                Button { state.insertSkill(skill) } label: { Image(systemName: "return") }
                    .buttonStyle(.plain).foregroundStyle(.tint).opacity(hover ? 1 : 0).help(String(localized: "Insérer /\(skill.name) dans le prompt"))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(count: 2) { if !skill.autoOnly { state.insertSkill(skill) } }
        .contextMenu {
            if !skill.autoOnly { Button("Insérer dans le prompt") { state.insertSkill(skill) } }
            Button(skill.editable ? L("Modifier…") : L("Voir…")) { state.editingSkill = skill }
            Button("Afficher dans le Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: skill.path)]) }
            Divider()
            if let r = state.active?.root, skill.source != .project {
                Button("Copier dans le projet") { try_ { try SkillStore.duplicate(skill, toProjectRoot: r) }; onRefresh() }
            }
            if skill.source != .personal {
                Button("Copier en perso") { try_ { try SkillStore.duplicate(skill, toProjectRoot: nil) }; onRefresh() }
            }
            if skill.editable {
                Divider()
                Button("Supprimer…", role: .destructive) {
                    let a = NSAlert(); a.messageText = String(localized: "Mettre « /\(skill.name) » à la corbeille ?"); a.alertStyle = .warning
                    a.addButton(withTitle: L("Corbeille")); a.addButton(withTitle: L("Annuler"))
                    if a.runModal() == .alertFirstButtonReturn { try_ { try SkillStore.trash(skill) }; onRefresh() }
                }
            }
        }
    }

    private func try_(_ f: () throws -> Void) {
        do { try f() } catch { NSAlert(error: error).runModal() }
    }
}

// MARK: - new / import menu

struct NewSkillMenu: View {
    let projectRoot: String?          // nil = personal
    let onCreate: () -> Void
    @EnvironmentObject var state: AppState

    var body: some View {
        Menu {
            Button("Créer…") { onCreate() }
            Button("Importer un fichier ou un dossier…") { pick() }
        } label: { Label("Nouveau skill", systemImage: "plus") }
        .menuStyle(.borderedButton).fixedSize().controlSize(.small)
    }

    private func pick() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.init(filenameExtension: "md")!, .folder]
        panel.message = projectRoot == nil ? L("Importer dans ~/.claude/skills") : L("Importer dans le projet")
        guard panel.runModal() == .OK else { return }
        SkillImport.run(panel.urls, projectRoot: projectRoot, state: state)
    }
}

enum SkillImport {
    static func run(_ urls: [URL], projectRoot: String?, state: AppState) {
        var last: String?
        for u in urls {
            do { last = try SkillStore.importSkill(from: u, projectRoot: projectRoot) }
            catch { NSAlert(error: error).runModal() }
        }
        state.skillsVersion += 1
        if urls.count == 1, let p = last {
            let f = SkillStore.frontmatter(p)
            state.editingSkill = SkillInfo(name: f["name"] ?? "", description: f["description"] ?? "", path: p,
                                           source: projectRoot == nil ? .personal : .project, isCommand: false)
        }
    }

    /// Drop handler: accepts file URLs.
    static func handleDrop(_ providers: [NSItemProvider], projectRoot: String?, state: AppState) -> Bool {
        let group = DispatchGroup()
        var urls: [URL] = []
        for p in providers where p.hasItemConformingToTypeIdentifier("public.file-url") {
            group.enter()
            p.loadItem(forTypeIdentifier: "public.file-url", options: nil) { item, _ in
                if let d = item as? Data, let u = URL(dataRepresentation: d, relativeTo: nil) { urls.append(u) }
                else if let u = item as? URL { urls.append(u) }
                group.leave()
            }
        }
        group.notify(queue: .main) { if !urls.isEmpty { run(urls, projectRoot: projectRoot, state: state) } }
        return !providers.isEmpty
    }
}

// MARK: - project skills (left column)

struct ProjectSkillsPanel: View {
    @EnvironmentObject var project: Project
    @EnvironmentObject var state: AppState
    @State private var skills: [SkillInfo] = []
    @State private var showNew = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    NewSkillMenu(projectRoot: project.root) { showNew = true }
                    Spacer()
                    Button { reload() } label: { Image(systemName: "arrow.clockwise") }.controlSize(.small)
                }
                if skills.isEmpty {
                    Text("Aucun skill dans ce projet.\nLes skills vivent dans .claude/skills/<nom>/SKILL.md.")
                        .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center).padding(.top, 4)
                } else {
                    VStack(spacing: 0) {
                        ForEach(skills) { s in
                            SkillRow(skill: s, showSource: s.source == .linked, onRefresh: reload)
                            if s.id != skills.last?.id { Divider() }
                        }
                    }
                    .modifier(BorderedBlock())
                }
            }
            .padding(10)
        }
        .onDrop(of: ["public.file-url"], isTargeted: nil) { SkillImport.handleDrop($0, projectRoot: project.root, state: state) }
        .onAppear { DispatchQueue.main.async(execute: reload) }
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in reload() }
        .onChange(of: project.links) { _, _ in reload() }
        .onChange(of: state.skillsVersion) { _, _ in reload() }
        .sheet(isPresented: $showNew) { NewSkillSheet(defaultScope: .project).environmentObject(state).environmentObject(project) }
    }

    private func reload() {
        guard let r = project.root else { skills = []; return }
        skills = SkillStore.projectSkills(root: r) + project.links.flatMap { SkillStore.projectSkills(root: $0.path, source: .linked) }
    }
}

// MARK: - global skills (right panel)

struct GlobalSkillsTab: View {
    @EnvironmentObject var state: AppState
    @State private var personal: [SkillInfo] = []
    @State private var plugins: [SkillInfo] = []
    @State private var query = ""
    @State private var showNew = false

    private func filtered(_ list: [SkillInfo]) -> [SkillInfo] {
        query.isEmpty ? list : list.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("Filtrer…", text: $query).textFieldStyle(.roundedBorder).controlSize(.small)
                NewSkillMenu(projectRoot: nil) { showNew = true }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            List {
                Section("Perso") {
                    if filtered(personal).isEmpty { Text("Aucun skill perso").foregroundStyle(.secondary).font(.callout) }
                    ForEach(filtered(personal)) { SkillRow(skill: $0, showSource: false, onRefresh: reload).listRowInsets(EdgeInsets()) }
                }
                Section("Plugins") {
                    ForEach(filtered(plugins)) { SkillRow(skill: $0, showSource: false, onRefresh: reload).listRowInsets(EdgeInsets()) }
                }
            }
            .listStyle(.inset).scrollContentBackground(.hidden)
            .onDrop(of: ["public.file-url"], isTargeted: nil) { SkillImport.handleDrop($0, projectRoot: nil, state: state) }
        }
        .onAppear(perform: reload)
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in reload() }
        .onChange(of: state.skillsVersion) { _, _ in reload() }
        .sheet(isPresented: $showNew) { NewSkillSheet(defaultScope: .personal).environmentObject(state) }
    }

    private func reload() {
        personal = SkillStore.personal()
        plugins = SkillStore.plugins()
    }
}

// MARK: - sheets

struct NewSkillSheet: View {
    enum Scope { case project, personal }
    let defaultScope: Scope
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var scope: Scope = .project
    @State private var mode = 0   // 0 auto + /, 1 manuel, 2 auto seulement
    @State private var error: String?

    private var projectRoot: String? { state.active?.root }
    private var valid: Bool { SkillStore.isValidName(name) && !description.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Nouveau skill").font(.title3.weight(.semibold))
            Form {
                TextField("Nom", text: $name, prompt: Text("release-notes"))
                    .onChange(of: name) { _, v in
                        name = v.lowercased().replacingOccurrences(of: " ", with: "-").filter { $0.isLetter || $0.isNumber || $0 == "-" }
                    }
                TextField("Description", text: $description, prompt: Text("Quand et pourquoi Claude doit l'utiliser"), axis: .vertical)
                    .lineLimit(2...4)
                Picker("Invocation", selection: $mode) {
                    Text("Automatique ou /nom").tag(0)
                    Text("Manuelle uniquement (/nom)").tag(1)
                    Text("Automatique seulement").tag(2)
                }
                if projectRoot != nil {
                    Picker("Emplacement", selection: $scope) {
                        Text(String(localized: "Projet · \(state.active?.name ?? "")")).tag(Scope.project)
                        Text("Perso (~/.claude/skills)").tag(Scope.personal)
                    }
                }
            }
            .formStyle(.columns)
            if let e = error { Text(e).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Créer vide") { create(withClaude: false) }.disabled(!valid)
                Button("Rédiger avec Claude") { create(withClaude: true) }
                    .buttonStyle(.borderedProminent).disabled(!valid).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { scope = projectRoot == nil ? .personal : defaultScope }
    }

    private func create(withClaude: Bool) {
        do {
            let root = scope == .project ? projectRoot : nil
            let path = try SkillStore.create(name: name, description: description, projectRoot: root,
                                             extra: mode == 1 ? "disable-model-invocation: true" : (mode == 2 ? "user-invocable: false" : nil))
            state.skillsVersion += 1
            dismiss()
            if withClaude {
                let prompt = String(localized: "Rédige le skill Claude Code \(path) : \(description). Garde le frontmatter name/description, écris des instructions précises et actionnables (quand l'utiliser, étapes, contraintes), en français.")
                state.sendToClaude(prompt)
            } else {
                state.editingSkill = SkillInfo(name: name, description: description, path: path, source: root == nil ? .personal : .project, isCommand: false)
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct SkillEditorSheet: View {
    let skill: SkillInfo
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var original = ""
    @State private var extras: [String] = []

    private var dirty: Bool { text != original }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: skill.isCommand ? "slash.circle" : "sparkle").foregroundStyle(.tint)
                Text("/" + skill.name).font(.headline)
                Badge(text: L(skill.source.rawValue), color: .secondary)
                if dirty { Badge(text: L("modifié"), color: .orange) }
                Spacer()
                Text(skill.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            Divider()
            TextEditor(text: $text)
                .font(.system(size: 12, design: .monospaced))
                .disabled(!skill.editable)
                .padding(4)
            if !extras.isEmpty {
                Divider()
                HStack(spacing: 8) {
                    Text("Fichiers annexes :").font(.caption).foregroundStyle(.secondary)
                    ForEach(extras, id: \.self) { f in
                        Button(f) { NSWorkspace.shared.open(URL(fileURLWithPath: skill.dir + "/" + f)) }
                            .buttonStyle(.link).font(.caption)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            Divider()
            HStack {
                Button("Ouvrir dans l'éditeur externe") { NSWorkspace.shared.open(URL(fileURLWithPath: skill.path)) }
                Spacer()
                Button(skill.editable ? L("Annuler") : L("Fermer")) { dismiss() }.keyboardShortcut(.cancelAction)
                if skill.editable {
                    Button("Enregistrer") { save() }.buttonStyle(.borderedProminent).disabled(!dirty).keyboardShortcut("s")
                }
            }
            .padding(12)
        }
        .frame(width: 760, height: 560)
        .onAppear {
            original = (try? String(contentsOfFile: skill.path, encoding: .utf8)) ?? ""
            text = original
            if !skill.isCommand {
                extras = ((try? FileManager.default.contentsOfDirectory(atPath: skill.dir)) ?? []).filter { $0 != "SKILL.md" && !$0.hasPrefix(".") }.sorted()
            }
        }
    }

    private func save() {
        do {
            try text.write(toFile: skill.path, atomically: true, encoding: .utf8)
            original = text
            state.skillsVersion += 1
            dismiss()
        } catch { NSAlert(error: error).runModal() }
    }
}
