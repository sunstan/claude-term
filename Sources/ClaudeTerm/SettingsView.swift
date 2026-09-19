import SwiftUI
import AppKit

/// Loads ~/.claude/settings.json into a mutable dictionary and exposes typed bindings.
/// Unknown keys are preserved untouched on save.
final class SettingsModel: ObservableObject {
    @Published var root: [String: Any] = [:]
    @Published var status = ""
    @Published var dirty = false
    let path: String

    init(path: String = ClaudeData.settingsPath) { self.path = path; load() }

    func load() {
        if let d = FileManager.default.contents(atPath: path),
           let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            root = o
        } else { root = [:] }
        dirty = false
        status = ""
    }

    func save() {
        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            dirty = false
            status = "Enregistré"
        } catch { status = "Erreur : \(error.localizedDescription)" }
    }

    var rawJSON: String {
        get {
            (try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        }
        set {
            if let d = newValue.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                root = o; dirty = true; status = ""
            } else { status = "JSON invalide" }
        }
    }

    // MARK: path helpers ("permissions.allow")
    private func get(_ path: [String]) -> Any? {
        var cur: Any? = root
        for k in path { cur = (cur as? [String: Any])?[k] }
        return cur
    }

    private func set(_ path: [String], _ value: Any?) {
        func rec(_ dict: [String: Any], _ i: Int) -> [String: Any] {
            var d = dict
            if i == path.count - 1 {
                if let v = value { d[path[i]] = v } else { d.removeValue(forKey: path[i]) }
            } else {
                d[path[i]] = rec(d[path[i]] as? [String: Any] ?? [:], i + 1)
                if (d[path[i]] as? [String: Any])?.isEmpty == true { d.removeValue(forKey: path[i]) }
            }
            return d
        }
        root = rec(root, 0)
        dirty = true
        status = ""
    }

    func string(_ path: String, default def: String = "") -> Binding<String> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { self.get(p) as? String ?? def },
                       set: { self.set(p, $0.isEmpty ? nil : $0) })
    }

    func bool(_ path: String, default def: Bool = false) -> Binding<Bool> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { self.get(p) as? Bool ?? def }, set: { self.set(p, $0) })
    }

    func int(_ path: String, default def: Int = 0) -> Binding<Int> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { self.get(p) as? Int ?? def }, set: { self.set(p, $0 == def ? nil : $0) })
    }

    func list(_ path: String) -> Binding<[String]> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { self.get(p) as? [String] ?? [] },
                       set: { self.set(p, $0.isEmpty ? nil : $0) })
    }

    func dict(_ path: String) -> Binding<[String: String]> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { (self.get(p) as? [String: Any])?.compactMapValues { "\($0)" } ?? [:] },
                       set: { self.set(p, $0.isEmpty ? nil : $0) })
    }

    func boolDict(_ path: String) -> Binding<[String: Bool]> {
        let p = path.split(separator: ".").map(String.init)
        return Binding(get: { (self.get(p) as? [String: Any])?.compactMapValues { $0 as? Bool } ?? [:] },
                       set: { self.set(p, $0.isEmpty ? nil : $0) })
    }

    // Hooks: { event: [ { matcher, hooks: [ {type: command, command, …} ] } ] }
    // Edited in place: other events, non-command hooks and extra fields (timeout, async…) are preserved.
    struct HookEntry: Identifiable, Equatable {
        let event: String
        let group: Int
        let index: Int
        var matcher: String
        var command: String
        var id: String { "\(event)/\(group)/\(index)" }
    }
    static let hookEvents = ["PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SubagentStop", "UserPromptSubmit", "SessionStart", "SessionEnd", "PreCompact"]

    var hooks: [HookEntry] {
        var out: [HookEntry] = []
        guard let h = root["hooks"] as? [String: Any] else { return [] }
        for ev in h.keys.sorted() {
            for (gi, group) in (h[ev] as? [[String: Any]] ?? []).enumerated() {
                let matcher = group["matcher"] as? String ?? ""
                for (hi, hk) in (group["hooks"] as? [[String: Any]] ?? []).enumerated() where hk["type"] as? String == "command" {
                    out.append(HookEntry(event: ev, group: gi, index: hi, matcher: matcher, command: hk["command"] as? String ?? ""))
                }
            }
        }
        return out
    }

    private func mutateHooks(_ body: (inout [String: Any]) -> Void) {
        var h = root["hooks"] as? [String: Any] ?? [:]
        body(&h)
        root["hooks"] = h.isEmpty ? nil : h
        dirty = true; status = ""
    }

    func setHookCommand(_ e: HookEntry, _ command: String) {
        mutateHooks { h in
            guard var groups = h[e.event] as? [[String: Any]], e.group < groups.count,
                  var hooks = groups[e.group]["hooks"] as? [[String: Any]], e.index < hooks.count else { return }
            hooks[e.index]["command"] = command
            groups[e.group]["hooks"] = hooks
            h[e.event] = groups
        }
    }

    func setHookMatcher(_ e: HookEntry, _ matcher: String) {
        mutateHooks { h in
            guard var groups = h[e.event] as? [[String: Any]], e.group < groups.count else { return }
            if matcher.isEmpty { groups[e.group].removeValue(forKey: "matcher") } else { groups[e.group]["matcher"] = matcher }
            h[e.event] = groups
        }
    }

    /// Moving to another event = remove here, append there (as its own group).
    func setHookEvent(_ e: HookEntry, _ event: String) {
        guard event != e.event else { return }
        removeHook(e)
        addHook(event: event, matcher: e.matcher, command: e.command)
    }

    func removeHook(_ e: HookEntry) {
        mutateHooks { h in
            guard var groups = h[e.event] as? [[String: Any]], e.group < groups.count,
                  var hooks = groups[e.group]["hooks"] as? [[String: Any]], e.index < hooks.count else { return }
            hooks.remove(at: e.index)
            if hooks.isEmpty { groups.remove(at: e.group) } else { groups[e.group]["hooks"] = hooks }
            if groups.isEmpty { h.removeValue(forKey: e.event) } else { h[e.event] = groups }
        }
    }

    func addHook(event: String, matcher: String = "", command: String = "") {
        mutateHooks { h in
            var groups = h[event] as? [[String: Any]] ?? []
            var g: [String: Any] = ["hooks": [["type": "command", "command": command]]]
            if !matcher.isEmpty { g["matcher"] = matcher }
            groups.append(g)
            h[event] = groups
        }
    }
}

struct SettingsTab: View {
    @StateObject private var m = SettingsModel()
    @State private var showRaw = false

    private let models = ["", "fable[1m]", "fable", "opus[1m]", "opus", "sonnet", "haiku"]
    private let efforts = ["", "low", "medium", "high", "xhigh", "max"]
    private let modes = ["", "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("settings.json", systemImage: "gearshape").font(.caption).foregroundStyle(.secondary)
                if m.dirty { Badge(text: L("modifié"), color: .orange) }
                Spacer()
                Text(m.status).font(.caption2).foregroundStyle(.secondary)
                Button("Recharger") { m.load() }.controlSize(.small)
                Button("Enregistrer") { m.save() }.controlSize(.small).keyboardShortcut("s")
                    .buttonStyle(.borderedProminent).disabled(!m.dirty)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            Form {
                Section("Général") {
                    Picker("Modèle", selection: m.string("model")) {
                        ForEach(models, id: \.self) { Text($0.isEmpty ? "par défaut" : $0).tag($0) }
                    }
                    Picker("Effort", selection: m.string("effortLevel")) {
                        ForEach(efforts, id: \.self) { Text($0.isEmpty ? "par défaut" : $0).tag($0) }
                    }
                    Picker("Interface", selection: m.string("tui")) {
                        Text("par défaut").tag(""); Text("fullscreen").tag("fullscreen"); Text("inline").tag("inline")
                    }
                    TextField("Langue", text: m.string("language"), prompt: Text("ex. français"))
                    Toggle("Réflexion étendue toujours active", isOn: m.bool("alwaysThinkingEnabled"))
                    Toggle("Co-Authored-By dans les commits", isOn: m.bool("includeCoAuthoredBy", default: true))
                    Stepper("Purge des transcripts : \(m.int("cleanupPeriodDays", default: 30).wrappedValue) j",
                            value: m.int("cleanupPeriodDays", default: 30), in: 1...365)
                    TextField("Status line", text: m.string("statusLine.command"), prompt: Text("commande"))
                }

                Section("Permissions") {
                    Picker("Mode par défaut", selection: m.string("permissions.defaultMode")) {
                        ForEach(modes, id: \.self) { Text($0.isEmpty ? "par défaut" : $0).tag($0) }
                    }
                    ListEditor(title: "Autorisées", items: m.list("permissions.allow"), placeholder: "Bash(npm run:*)")
                    ListEditor(title: "À confirmer", items: m.list("permissions.ask"), placeholder: "Bash(git push:*)")
                    ListEditor(title: "Refusées", items: m.list("permissions.deny"), placeholder: "Read(./.env)")
                    ListEditor(title: "Dossiers supplémentaires", items: m.list("permissions.additionalDirectories"), placeholder: "/chemin")
                }

                Section("Hooks") {
                    HooksEditor(model: m)
                }

                Section("Variables d'environnement") {
                    DictEditor(items: m.dict("env"))
                }

                Section("Plugins") {
                    PluginsEditor(items: m.boolDict("enabledPlugins"))
                }

                Section {
                    DisclosureGroup("JSON brut", isExpanded: $showRaw) {
                        RawJSONEditor(model: m)
                    }
                }
            }
            .formStyle(.grouped)
        }
    }
}

struct ListEditor: View {
    let title: String
    @Binding var items: [String]
    let placeholder: String
    @State private var draft = ""

    var body: some View {
        DisclosureGroup {
            ForEach(Array(items.enumerated()), id: \.offset) { i, _ in
                HStack {
                    TextField("", text: Binding(
                        get: { i < items.count ? items[i] : "" },
                        set: { if i < items.count { items[i] = $0 } }))
                        .font(.system(size: 11, design: .monospaced))
                    Button { if i < items.count { items.remove(at: i) } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            HStack {
                TextField("", text: $draft, prompt: Text(placeholder))
                    .font(.system(size: 11, design: .monospaced))
                    .onSubmit(add)
                Button(action: add) { Image(systemName: "plus.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.tint).disabled(draft.isEmpty)
            }
        } label: {
            HStack { Text(title); Spacer(); Text("\(items.count)").foregroundStyle(.secondary) }
        }
    }

    private func add() {
        guard !draft.isEmpty else { return }
        items.append(draft); draft = ""
    }
}

struct DictEditor: View {
    @Binding var items: [String: String]
    @State private var key = ""
    @State private var value = ""

    var body: some View {
        ForEach(items.keys.sorted(), id: \.self) { k in
            HStack {
                Text(k).font(.system(size: 11, design: .monospaced)).frame(width: 150, alignment: .leading)
                TextField("", text: Binding(get: { items[k] ?? "" }, set: { items[k] = $0 }))
                    .font(.system(size: 11, design: .monospaced))
                Button { items.removeValue(forKey: k) } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        HStack {
            TextField("", text: $key, prompt: Text("NOM")).frame(width: 150)
            TextField("", text: $value, prompt: Text("valeur")).onSubmit(add)
            Button(action: add) { Image(systemName: "plus.circle.fill") }
                .buttonStyle(.plain).foregroundStyle(.tint).disabled(key.isEmpty)
        }
        .font(.system(size: 11, design: .monospaced))
    }

    private func add() {
        guard !key.isEmpty else { return }
        items[key] = value; key = ""; value = ""
    }
}

struct PluginsEditor: View {
    @Binding var items: [String: Bool]
    var body: some View {
        if items.isEmpty { Text("Aucun plugin").foregroundStyle(.secondary) }
        ForEach(items.keys.sorted(), id: \.self) { k in
            Toggle(k, isOn: Binding(get: { items[k] ?? false }, set: { items[k] = $0 }))
        }
    }
}

struct HooksEditor: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        let hooks = model.hooks
        if hooks.isEmpty { Text("Aucun hook").foregroundStyle(.secondary) }
        ForEach(hooks) { h in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Picker("", selection: Binding(get: { h.event }, set: { model.setHookEvent(h, $0) })) {
                        ForEach(SettingsModel.hookEvents + (SettingsModel.hookEvents.contains(h.event) ? [] : [h.event]), id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().frame(width: 160)
                    TextField("", text: Binding(get: { h.matcher }, set: { model.setHookMatcher(h, $0) }), prompt: Text("matcher (ex. Bash)"))
                    Button { model.removeHook(h) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                TextField("", text: Binding(get: { h.command }, set: { model.setHookCommand(h, $0) }), prompt: Text("commande"))
                    .font(.system(size: 11, design: .monospaced))
            }
            .padding(.vertical, 2)
        }
        Button { model.addHook(event: "Notification") } label: {
            Label("Ajouter un hook", systemImage: "plus.circle.fill")
        }
        .buttonStyle(.plain).foregroundStyle(.tint)
        Button {
            model.addHook(event: "Notification", command: "osascript -e 'display notification \"Claude attend une réponse\" with title \"ClaudeTerm\"'")
            model.addHook(event: "Stop", command: "osascript -e 'display notification \"Claude a terminé\" with title \"ClaudeTerm\"'")
        } label: { Label("Préréglage : notifications macOS", systemImage: "bell") }
        .buttonStyle(.plain).foregroundStyle(.secondary)
    }
}

struct RawJSONEditor: View {
    @ObservedObject var model: SettingsModel
    @State private var text = ""
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            TextEditor(text: $text)
                .font(.system(size: 11, design: .monospaced))
                .frame(minHeight: 220)
            Button("Appliquer le JSON") { model.rawJSON = text }.controlSize(.small)
        }
        .onAppear { text = model.rawJSON }
        .onChange(of: model.dirty) { _, d in if !d { text = model.rawJSON } }
    }
}
