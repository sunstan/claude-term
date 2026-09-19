import SwiftUI
import AppKit

/// A folder Claude should know about from this project (front → api, design-system…).
struct LinkedProject: Identifiable, Codable, Equatable {
    var path: String
    var role: String = ""
    var readOnly: Bool = false
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
}

/// Persists links: roles in .claude/claudeterm.json (ours), access in .claude/settings.local.json (Claude Code's).
enum LinkStore {
    static func load(root: String) -> [LinkedProject] {
        guard let d = FileManager.default.contents(atPath: root + "/.claude/claudeterm.json"),
              let o = try? JSONDecoder().decode([String: [LinkedProject]].self, from: d) else { return [] }
        return o["links"] ?? []
    }

    static func save(root: String, links: [LinkedProject]) throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: root + "/.claude", withIntermediateDirectories: true)
        let ours = Set(load(root: root).map(\.path))            // previous links, to drop cleanly
        // 1. our file (roles)
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(["links": links]).write(to: URL(fileURLWithPath: root + "/.claude/claudeterm.json"))
        // 2. Claude Code settings.local.json: additionalDirectories + deny rules for read-only links
        let sp = root + "/.claude/settings.local.json"
        var settings: [String: Any] = [:]
        if let d = fm.contents(atPath: sp), !d.isEmpty {
            guard let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                throw NSError(domain: "ClaudeTerm", code: 1, userInfo: [NSLocalizedDescriptionKey: L("settings.local.json illisible, rien n'a été écrit")])
            }
            settings = o
        }
        var perms = settings["permissions"] as? [String: Any] ?? [:]
        let existingDirs = perms["additionalDirectories"] as? [String] ?? []
        let kept = existingDirs.filter { !ours.contains($0) }
        let dirs = kept + links.map(\.path).filter { !kept.contains($0) }
        perms["additionalDirectories"] = dirs.isEmpty ? nil : dirs
        // Claude Code rule syntax: a single leading "/" is project-relative, "//" is absolute.
        var deny = (perms["deny"] as? [String] ?? []).filter { rule in
            !ours.contains { rule == "Edit(//\($0)/**)" || rule == "Write(//\($0)/**)" || rule == "Edit(\($0)/**)" || rule == "Write(\($0)/**)" }
        }
        for l in links where l.readOnly { deny += ["Edit(//\(l.path)/**)", "Write(//\(l.path)/**)"] }
        perms["deny"] = deny.isEmpty ? nil : deny
        settings["permissions"] = perms.isEmpty ? nil : perms
        let data = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: URL(fileURLWithPath: sp))
        // 3. system prompt text used by the `claude` shell function and by Claude tabs
        let prompt = systemPrompt(root: root, links: links)
        let pp = root + "/.claude/claudeterm-prompt.txt"
        if prompt.isEmpty { try? fm.removeItem(atPath: pp) } else { try prompt.write(toFile: pp, atomically: true, encoding: .utf8) }
    }

    static func systemPrompt(root: String, links: [LinkedProject]) -> String {
        guard !links.isEmpty else { return "" }
        var s = "Ce projet (\((root as NSString).lastPathComponent), \(root)) fait partie d'un ensemble de projets liés, déjà accessibles sans demander :\n"
        for l in links {
            s += "- \(l.name)"
            if !l.role.isEmpty { s += " (\(l.role))" }
            s += " : \(l.path)"
            if l.readOnly { s += " [lecture seule : ne pas modifier]" }
            s += "\n"
        }
        s += "Va lire ces dossiers directement quand une tâche touche à leurs interfaces (API, composants, types) au lieu de demander où ils sont."
        return s
    }

    static func promptPath(root: String) -> String { root + "/.claude/claudeterm-prompt.txt" }
}

/// Popover to manage a project's links.
struct LinksEditor: View {
    @EnvironmentObject var project: Project
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Rôles et accès").font(.headline)
            Text("Écrit dans .claude/settings.local.json du projet. Le rôle est transmis à Claude au lancement.")
                .font(.caption).foregroundStyle(.secondary)
            if project.links.isEmpty {
                Text("Aucun projet lié").foregroundStyle(.secondary).padding(.vertical, 6)
            }
            ForEach($project.links) { $l in
                HStack(spacing: 8) {
                    Image(systemName: "link").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(l.name).font(.system(size: 12, weight: .semibold))
                        TextField("rôle (api, design system…)", text: $l.role).textFieldStyle(.roundedBorder).controlSize(.small)
                    }
                    Toggle("lecture seule", isOn: $l.readOnly).toggleStyle(.checkbox).controlSize(.small)
                    Button { project.removeLink(l) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            if let e = project.linkError { Text(e).font(.caption).foregroundStyle(.red) }
        }
        .padding(14)
        .frame(width: 380)
        .onDisappear { project.saveLinks() }
    }
}
