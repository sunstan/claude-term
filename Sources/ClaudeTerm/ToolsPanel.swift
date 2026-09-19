import SwiftUI
import AppKit

enum ToolTab: String, CaseIterable {
    case sessions = "Process"
    case history = "Historique"
    case skills = "Skills"
    case mcp = "MCP"
    case settings = "Réglages"

    var icon: String {
        switch self {
        case .sessions: return "cpu"
        case .history: return "clock.arrow.circlepath"
        case .skills: return "sparkle"
        case .mcp: return "point.3.connected.trianglepath.dotted"
        case .settings: return "gearshape"
        }
    }
}

struct ToolsPanel: View {
    @EnvironmentObject var project: Project
    @State private var tab: ToolTab = .sessions

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                ForEach(ToolTab.allCases, id: \.self) { t in
                    Button { tab = t } label: {
                        VStack(spacing: 3) {
                            Image(systemName: t.icon).font(.system(size: 14))
                            Text(key: t.rawValue).font(.system(size: 10))
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                        .foregroundStyle(tab == t ? Color.accentColor : Color.secondary)
                        .background(tab == t ? Color.accentColor.opacity(0.12) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .contentShape(RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 4)
            Divider()
            switch tab {
            case .sessions: SessionsTab()
            case .history: HistoryTab()
            case .skills: GlobalSkillsTab()
            case .mcp: GlobalMCPTab()
            case .settings: SettingsTab()
            }
        }
    }
}

struct EmptyHint: View {
    let text: LocalizedStringKey
    init(_ t: LocalizedStringKey) { text = t }
    init(_ t: String) { text = LocalizedStringKey(t) }
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.system(size: 26)).foregroundStyle(.tertiary)
            Text(text).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SessionsTab: View {
    @EnvironmentObject var state: AppState
    @ObservedObject var monitor = ProcessMonitor.shared

    /// Matches a running process to one of our tabs (same cwd, started just after the tab).
    private func tab(for p: ClaudeProcess) -> TerminalSession? {
        let pc = URL(fileURLWithPath: p.cwd).resolvingSymlinksInPath().path
        return state.allSessions.filter {
            $0.isClaude && URL(fileURLWithPath: $0.cwd).resolvingSymlinksInPath().path == pc
                && p.started >= $0.claudeStartedAt.addingTimeInterval(-5)
        }
        .min { abs($0.claudeStartedAt.timeIntervalSince(p.started)) < abs($1.claudeStartedAt.timeIntervalSince(p.started)) }
    }

    var body: some View {
        List {
            Section {
                if monitor.processes.isEmpty {
                    Text("Aucun process Claude en cours").font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(monitor.processes) { p in
                        ProcessRow(process: p, tab: tab(for: p))
                    }
                }
            } header: {
                HStack {
                    Label("En cours sur ce Mac", systemImage: "cpu")
                    Spacer()
                    Text(verbatim: "\(monitor.processes.count)").foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.sidebar).scrollContentBackground(.hidden)
        .onAppear { monitor.start() }
        .onChange(of: state.allSessions.count) { _, _ in monitor.refresh() }
    }
}

struct HistoryTab: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var project: Project
    @State private var sessions: [ClaudeSessionInfo] = []
    @State private var scope = 0   // 0 = projet, 1 = tous
    @State private var query = ""

    private var folder: String { project.root ?? project.selectedFolder }

    private var filtered: [ClaudeSessionInfo] {
        guard !query.isEmpty else { return sessions }
        return sessions.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.projectPath.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Picker("", selection: $scope) {
                    Text((folder as NSString).lastPathComponent).tag(0)
                    Text("Tous les projets").tag(1)
                }
                .pickerStyle(.segmented).labelsHidden()
                TextField("Rechercher…", text: $query).textFieldStyle(.roundedBorder)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            if filtered.isEmpty {
                EmptyHint(query.isEmpty ? L("Aucune session") : L("Aucun résultat"))
            } else {
                List(filtered) { s in
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(s.title).lineLimit(2).font(.system(size: 12))
                            HStack(spacing: 6) {
                                Text(s.modified.formatted(.relative(presentation: .named)))
                                if scope == 1 {
                                    Text("·")
                                    Text((s.projectPath as NSString).lastPathComponent).lineLimit(1)
                                }
                                if s.messageCount > 0 { Text("· \(s.messageCount) msg") }
                                if !s.gitBranch.isEmpty { Text("· \(s.gitBranch)").lineLimit(1) }
                            }
                            .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button { resume(s) } label: {
                            Image(systemName: "play.circle.fill").font(.system(size: 16))
                        }
                        .buttonStyle(.plain).foregroundStyle(.tint).help("Reprendre (--resume)")
                        Button { confirmDelete(s) } label: {
                            Image(systemName: "trash").font(.system(size: 12))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary).help("Mettre à la corbeille")
                    }
                    .padding(.vertical, 3)
                    .contextMenu {
                        Button("Reprendre (--resume)") { resume(s) }
                        Button("Copier l'ID") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(s.id, forType: .string)
                        }
                        Button("Ouvrir le transcript") { NSWorkspace.shared.open(URL(fileURLWithPath: s.path)) }
                        Divider()
                        Button("Supprimer…", role: .destructive) { confirmDelete(s) }
                    }
                }
                .listStyle(.inset).scrollContentBackground(.hidden)
            }
        }
        .onAppear(perform: reload)
        .onChange(of: folder) { _, _ in reload() }
        .onChange(of: scope) { _, _ in reload() }
        .onChange(of: project.sessions.count) { _, _ in reload() }
    }

    private func resume(_ s: ClaudeSessionInfo) {
        let cwd = s.projectPath.hasPrefix("/") ? s.projectPath : folder
        if let r = project.root, cwd == r || cwd.hasPrefix(r + "/") {
            project.newClaudeTab(resume: s.id, cwd: cwd)
        } else {
            state.openProject(cwd).newClaudeTab(resume: s.id, cwd: cwd)
        }
    }

    private func reload() {
        sessions = scope == 0 ? ClaudeData.sessions(for: folder) : ClaudeData.allSessions()
    }

    private func confirmDelete(_ s: ClaudeSessionInfo) {
        let alert = NSAlert()
        alert.messageText = L("Supprimer cette session ?")
        alert.informativeText = String(localized: "« \(s.title) »\n\nLe transcript sera mis à la corbeille et retiré de la liste de reprise de Claude Code.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: L("Mettre à la corbeille"))
        alert.addButton(withTitle: L("Annuler"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { try ClaudeData.deleteSession(s) } catch {
            NSAlert(error: error).runModal()
        }
        reload()
    }
}

struct ProcessRow: View {
    let process: ClaudeProcess
    let tab: TerminalSession?
    @EnvironmentObject var state: AppState
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").foregroundStyle(.orange)
                Text((process.cwd as NSString).lastPathComponent).font(.system(size: 12, weight: .semibold))
                if let t = tab {
                    Badge(text: L("onglet"), color: .accentColor)
                        .onTapGesture { state.focus(t) }
                } else {
                    Badge(text: L("externe"), color: .secondary)
                }
                Spacer()
                Text(process.elapsed).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                KillButton(pid: process.pid, label: "Claude · \((process.cwd as NSString).lastPathComponent)", confirm: true, visible: hover)
            }
            HStack(spacing: 10) {
                Text(process.cwd.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Text("\(process.cpu)%  ·  \(process.memMB) MB")
            }
            .font(.caption2).foregroundStyle(.secondary)

            if let t = tab {
                ToolsRunning(session: t)
            }
            ForEach(process.children) { c in
                ChildRow(child: c)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .contextMenu {
            if let t = tab { Button("Aller à l'onglet") { state.focus(t) } }
            Button("Copier le PID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(String(process.pid), forType: .string)
            }
            Divider()
            Button("Arrêter (SIGTERM)", role: .destructive) { ProcessKiller.kill(process.pid, force: false, label: "Claude", confirm: true) }
            Button("Forcer l'arrêt (SIGKILL)", role: .destructive) { ProcessKiller.kill(process.pid, force: true, label: "Claude", confirm: true) }
        }
    }
}

private struct ChildRow: View {
    let child: ChildProcess
    @State private var hover = false
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.turn.down.right").font(.system(size: 9)).foregroundStyle(.tertiary)
            Text(child.command).font(.system(size: 10, design: .monospaced)).lineLimit(1)
            Spacer()
            Text("\(child.cpu)%").font(.caption2).foregroundStyle(.tertiary)
            KillButton(pid: child.pid, label: child.command, confirm: false, visible: hover)
        }
        .padding(.leading, 6)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .contextMenu {
            Button("Copier la commande") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(child.command, forType: .string)
            }
            Divider()
            Button("Arrêter (SIGTERM)", role: .destructive) { ProcessKiller.kill(child.pid, force: false, label: child.command, confirm: false) }
            Button("Forcer l'arrêt (SIGKILL)", role: .destructive) { ProcessKiller.kill(child.pid, force: true, label: child.command, confirm: false) }
        }
    }
}

private struct KillButton: View {
    let pid: Int
    let label: String
    let confirm: Bool
    let visible: Bool
    var body: some View {
        Button { ProcessKiller.kill(pid, force: false, label: label, confirm: confirm) } label: {
            Image(systemName: "stop.circle").font(.system(size: 12))
        }
        .buttonStyle(.plain).foregroundStyle(.red)
        .opacity(visible ? 1 : 0)
        .help("Arrêter (SIGTERM)")
    }
}

enum ProcessKiller {
    static func kill(_ pid: Int, force: Bool, label: String, confirm: Bool) {
        if confirm {
            let a = NSAlert()
            a.messageText = force ? "Forcer l'arrêt de cette session Claude ?" : "Arrêter cette session Claude ?"
            a.informativeText = String(localized: "\(label) (PID \(pid))\nLa session pourra être reprise depuis l'Historique.")
            a.alertStyle = .warning
            a.addButton(withTitle: force ? L("Forcer") : L("Arrêter"))
            a.addButton(withTitle: L("Annuler"))
            guard a.runModal() == .alertFirstButtonReturn else { return }
        }
        if Darwin.kill(pid_t(pid), force ? SIGKILL : SIGTERM) != 0 {
            let e = NSAlert(); e.messageText = String(localized: "Impossible d'arrêter le process \(pid)")
            e.informativeText = String(cString: strerror(errno)); e.runModal()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { ProcessMonitor.shared.refresh() }
    }
}

private struct ToolsRunning: View {
    @ObservedObject var session: TerminalSession
    var body: some View {
        ForEach(session.runningTools, id: \.id) { t in
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(t.name).font(.caption.bold())
                Text(t.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(.leading, 6)
        }
    }
}

struct PlanTab: View {
    @ObservedObject var session: TerminalSession
    @State private var allPlans: [PlanInfo] = []

    private var progress: (done: Int, total: Int) {
        var done = 0, total = 0
        for line in session.planText.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("- [x]") || t.hasPrefix("- [X]") { done += 1; total += 1 }
            else if t.hasPrefix("- [ ]") { total += 1 }
        }
        return (done, total)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if session.planMode {
                    Text("MODE PLAN").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.orange.opacity(0.25)).clipShape(Capsule())
                }
                if let pm = session.permissionMode {
                    Text(pm).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15)).clipShape(Capsule())
                }
                Spacer()
                if progress.total > 0 {
                    Text(verbatim: "\(progress.done)/\(progress.total)").font(.caption).foregroundStyle(.secondary)
                }
                Menu {
                    ForEach(allPlans) { p in
                        Button(p.title) { session.setPlan(p.path) }
                    }
                    if session.planPath != nil {
                        Divider()
                        Button("Ouvrir le fichier") { NSWorkspace.shared.open(URL(fileURLWithPath: session.planPath!)) }
                        Button("Détacher") { session.setPlan(nil) }
                    }
                } label: { Image(systemName: "list.clipboard") }
                .menuStyle(.borderlessButton).fixedSize()
                .onAppear { DispatchQueue.main.async { allPlans = ClaudeData.plans() } }
            }
            .padding(8)
            if progress.total > 0 {
                ProgressView(value: Double(progress.done), total: Double(progress.total))
                    .padding(.horizontal, 8).padding(.bottom, 4)
            }
            Divider()
            if session.planPath == nil {
                VStack(spacing: 10) {
                    Text("Aucun plan lié à cette session").foregroundStyle(.secondary)
                    Text("Le plan apparaîtra dès que Claude entre en mode plan.\nOu choisis un plan récent avec le menu ci-dessus.")
                        .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    MarkdownView(text: session.planText)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// Minimal block-level markdown renderer (headers, lists, checkboxes, code blocks, paragraphs).
struct MarkdownView: View {
    let text: String

    private enum Block {
        case heading(Int, String), bullet(Int, String), check(Bool, String), code(String), para(String), rule
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var code: [String]? = nil
        var para: [String] = []
        func flush() { if !para.isEmpty { out.append(.para(para.joined(separator: " "))); para = [] } }
        for raw in text.components(separatedBy: "\n") {
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let c = code { out.append(.code(c.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
                continue
            }
            if code != nil { code!.append(raw); continue }
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = (raw.count - raw.drop(while: { $0 == " " }).count) / 2
            if line.isEmpty { flush(); continue }
            if line.hasPrefix("#") {
                flush()
                let level = line.prefix(while: { $0 == "#" }).count
                out.append(.heading(level, String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)))
            } else if line == "---" || line == "***" {
                flush(); out.append(.rule)
            } else if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
                flush(); out.append(.check(!line.hasPrefix("- [ ]"), String(line.dropFirst(6))))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flush(); out.append(.bullet(indent, String(line.dropFirst(2))))
            } else if let r = line.range(of: #"^\d+\. "#, options: .regularExpression) {
                flush(); out.append(.bullet(indent, String(line[r.lowerBound...])))
            } else {
                para.append(line)
            }
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flush()
        return out
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    var body: some View {
        let blocks = self.blocks
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let l, let t):
                    Text(inline(t)).font(l == 1 ? .title3.bold() : l == 2 ? .headline : .subheadline.bold())
                        .padding(.top, l <= 2 ? 6 : 2)
                case .bullet(let indent, let t):
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inline(t))
                    }.padding(.leading, CGFloat(indent) * 14)
                case .check(let done, let t):
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: done ? "checkmark.square.fill" : "square")
                            .foregroundStyle(done ? Color.green : Color.secondary)
                        Text(inline(t)).strikethrough(done, color: .secondary)
                            .foregroundStyle(done ? .secondary : .primary)
                    }
                case .code(let c):
                    Text(c).font(.system(size: 11, design: .monospaced))
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 5))
                case .para(let t):
                    Text(inline(t))
                case .rule:
                    Divider()
                }
            }
        }
        .font(.system(size: 12))
        .textSelection(.enabled)
    }
}

struct ActivityTab: View {
    @ObservedObject var session: TerminalSession

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(verbatim: "in \(session.inputTokens.formatted())  ·  out \(session.outputTokens.formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if session.transcriptPath == nil {
                    Text("en attente du transcript…").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(8)
            Divider()
            ScrollViewReader { proxy in
                List(session.events) { e in
                    HStack(alignment: .top, spacing: 6) {
                        Text(icon(for: e.kind)).frame(width: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            if e.kind != "text" && e.kind != "user" {
                                Text(e.kind).font(.caption.bold())
                            }
                            Text(e.detail)
                                .font(.system(size: 11, design: e.kind == "Bash" ? .monospaced : .default))
                                .lineLimit(3)
                                .foregroundStyle(e.kind == "user" ? .primary : .secondary)
                        }
                    }
                    .id(e.id)
                    .contextMenu {
                        if let f = e.file { Button("Ouvrir \(f)") { NSWorkspace.shared.open(URL(fileURLWithPath: f)) } }
                        Button("Copier") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(e.file ?? e.detail, forType: .string)
                        }
                    }
                }
                .listStyle(.inset).scrollContentBackground(.hidden)
                .onChange(of: session.events.count) { _, _ in
                    if let last = session.events.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "user": return "👤"
        case "text": return "💬"
        case "Bash": return "⌘"
        case "Edit", "Write", "MultiEdit", "NotebookEdit", "Edit (bash)": return "✏️"
        case "Read": return "📄"
        case "Grep", "Glob": return "🔍"
        case "Agent", "Task": return "🤖"
        case "WebFetch", "WebSearch": return "🌐"
        default: return "🔧"
        }
    }
}

struct FilesTab: View {
    @ObservedObject var session: TerminalSession
    @State private var selected: String?
    @State private var diff: String = ""
    @State private var stats: [String: (Int, Int)] = [:]

    private func isModified(_ p: String) -> Bool { session.backups[p] != nil || session.bashDiffs[p] != nil }
    private var rows: [String] {
        session.files.keys.sorted { a, b in
            let ea = isModified(a), eb = isModified(b)
            return ea != eb ? ea : a < b       // modified files first
        }
    }
    /// Derived, never assigned during rendering (split views lay out from AppKit).
    private var current: String? {
        if let s = selected, session.files[s] != nil { return s }
        return rows.first { isModified($0) } ?? rows.first
    }

    var body: some View {
        if rows.isEmpty {
            EmptyHint("Aucun fichier touché pour l'instant")
        } else {
            HSplitView {
                List(rows, id: \.self, selection: Binding(get: { current }, set: { selected = $0 })) { path in
                    HStack(spacing: 6) {
                        Image(systemName: isModified(path) ? "pencil" : (isNew(path) ? "plus.circle" : "eye"))
                            .font(.system(size: 10)).foregroundStyle(isModified(path) ? Color.orange : (isNew(path) ? .green : .secondary))
                            .frame(width: 12)
                        VStack(alignment: .leading, spacing: 1) {
                            Text((path as NSString).lastPathComponent).font(.system(size: 12)).lineLimit(1)
                            Text(path.replacingOccurrences(of: session.cwd + "/", with: ""))
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        if let st = stats[path] {
                            Text(verbatim: "+\(st.0)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                            Text(verbatim: "−\(st.1)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
                        }
                    }
                    .tag(path)
                    .contextMenu {
                        Button("Ouvrir") { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                        Button("Afficher dans le Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                        Button("Copier le chemin") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(path, forType: .string) }
                        if isModified(path) || isNew(path) {
                            Button("Copier le diff") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(diffFor(path), forType: .string) }
                        }
                    }
                }
                .listStyle(.inset).scrollContentBackground(.hidden)
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 400)

                DiffView(text: diff, path: current)
                    .frame(minWidth: 300)
            }
            .onAppear { refresh() }
            .onChange(of: current) { _, _ in refresh() }
            .onChange(of: session.events.count) { _, _ in refresh() }
            .onChange(of: session.backups.count) { _, _ in refresh() }
            .onChange(of: session.bashDiffs.count) { _, _ in refresh() }
        }
    }

    /// Created by Claude in this session: written but never backed up, and not read before.
    private func isNew(_ path: String) -> Bool {
        session.backups[path] == nil && session.events.contains { ($0.kind == "Write") && $0.file == path }
            && !session.events.contains { $0.kind == "Read" && $0.file == path }
    }

    private func diffFor(_ path: String) -> String {
        guard let sid = session.sessionId else { return "" }
        if session.backups[path] != nil || isNew(path) {
            return ClaudeData.sessionDiff(path: path, backupName: session.backups[path]?.name, sessionId: sid)
        }
        if let hunks = session.bashDiffs[path] {
            return "--- avant\n+++ après\n" + hunks.joined(separator: "\n")
        }
        return ""
    }

    private func refresh() {
        let paths = rows, sel = current
        DispatchQueue.global(qos: .userInitiated).async {
            var st: [String: (Int, Int)] = [:]
            for p in paths where isModified(p) || isNew(p) {
                st[p] = ClaudeData.diffStats(diffFor(p))
            }
            let d = sel.map(diffFor) ?? ""
            DispatchQueue.main.async { stats = st; diff = d }
        }
    }
}

/// Read-only colored unified diff.
struct DiffView: View {
    let text: String
    let path: String?

    var body: some View {
        if let p = path, text.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "eye").font(.system(size: 22)).foregroundStyle(.tertiary)
                Text("Lu, pas modifié dans cette session").font(.callout).foregroundStyle(.secondary)
                Text((p as NSString).lastPathComponent).font(.caption).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if path == nil {
            EmptyHint("Sélectionne un fichier")
        } else {
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                        Text(verbatim: line.isEmpty ? " " : String(line))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(color(for: line))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .background(background(for: line))
                    }
                }
                .padding(.vertical, 6)
                .textSelection(.enabled)
            }
        }
    }

    private func color(for line: Substring) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") { return .secondary }
        if line.hasPrefix("@@") { return .blue }
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        return .primary
    }
    private func background(for line: Substring) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") { return .clear }
        if line.hasPrefix("+") { return .green.opacity(0.10) }
        if line.hasPrefix("-") { return .red.opacity(0.10) }
        return .clear
    }
}

