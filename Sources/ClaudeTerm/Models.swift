import SwiftUI
import SwiftTerm
import UserNotifications

enum TabKind {
    case claude(resume: String?)
    case shell
    case script(dir: String, name: String, command: String)
}

func shellQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

final class TerminalSession: NSObject, ObservableObject, Identifiable, LocalProcessTerminalViewDelegate {
    let id = UUID()
    @Published var cwd: String
    @Published var kind: TabKind
    /// A foreground command is running in this shell (reported by shell integration).
    @Published var busy = false
    @Published var lastCommand: String = ""
    @Published var lastExit: Int32? = nil
    let startedAt = Date()
    let view: ClaudeTerminalView
    weak var app: AppState?

    @Published var title: String
    @Published var alive = true

    // Claude transcript monitoring
    @Published var transcriptPath: String? {
        didSet {
            if let o = oldValue { ClaudeData.claimedTranscripts.remove(o) }
            if let n = transcriptPath { ClaudeData.claimedTranscripts.insert(n) }
        }
    }
    @Published var events: [ToolEvent] = []
    @Published var files: [String: Int] = [:]
    /// absolute path → earliest backup file name for this session (Claude Code file-history)
    @Published var backups: [String: (name: String, version: Int)] = [:]
    /// absolute path → diffs of edits made by Bash commands in this session
    @Published var bashDiffs: [String: [String]] = [:]
    var sessionId: String? { transcriptPath.map { (($0 as NSString).lastPathComponent as NSString).deletingPathExtension } }
    @Published var inputTokens = 0
    @Published var outputTokens = 0
    @Published var planPath: String?
    @Published var planText: String = ""
    @Published var planMode = false
    @Published var permissionMode: String?
    /// Tools currently executing (tool_use seen, no tool_result yet), in order.
    @Published var runningTools: [(id: String, name: String, detail: String)] = []
    private var planModified: Date?
    private var offset: UInt64 = 0
    private var timer: Timer?

    /// Something Claude is waiting for (from hooks); cleared on focus or new activity.
    @Published var attention: Attention?
    /// `claude` typed in a shell tab: detected by shell integration.
    @Published var claudeRunning = false
    private(set) var claudeStartedAt = Date()
    /// `claude --continue` / `--resume` typed in a shell: the transcript may pre-exist.
    private var claudeReusesTranscript = false
    var isClaude: Bool {
        if case .claude = kind { return true }
        return claudeRunning
    }
    var isScript: Bool { if case .script = kind { return true } else { return false } }

    init(cwd: String, kind: TabKind, projectRoot: String? = nil) {
        self.cwd = cwd
        self.kind = kind
        let name = (cwd as NSString).lastPathComponent
        switch kind {
        case .claude: title = "✳ \(name)"
        case .shell: title = name
        case .script(_, let n, _): title = "\(n) · \(name)"
        }
        view = ClaudeTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        super.init()

        view.processDelegate = self
        view.scrollerStyle = .overlay
        view.font = NSFont(name: "JetBrainsMono-Regular", size: 13)
            ?? NSFont(name: "SFMono-Regular", size: 13)
            ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        Theme.apply(to: view)

        var env = ProcessInfo.processInfo.environment
        // Never inherit markers from a Claude Code session that may have launched ClaudeTerm:
        // with CLAUDE_CODE_CHILD_SESSION set, claude disables transcript saving.
        for k in env.keys where k.hasPrefix("CLAUDE") { env.removeValue(forKey: k) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "ClaudeTerm"
        if env["LANG"] == nil { env["LANG"] = "fr_FR.UTF-8" }
        if case .claude = kind {} else {
            ShellIntegration.install()
            env["ZDOTDIR"] = ShellIntegration.dir
        }
        if let r = projectRoot { env["CLAUDETERM_ROOT"] = r }
        let envArray = env.map { "\($0.key)=\($0.value)" }

        switch kind {
        case .claude(let resume):
            var extra = ""
            if let r = projectRoot, let prompt = try? String(contentsOfFile: LinkStore.promptPath(root: r), encoding: .utf8), !prompt.isEmpty {
                extra = " --append-system-prompt-file \(shellQuote(LinkStore.promptPath(root: r)))"
            }
            let cmd = "exec claude" + (resume.map { " --resume \($0)" } ?? "") + extra
            view.startProcess(executable: "/bin/zsh", args: ["-l", "-c", cmd], environment: envArray, execName: "zsh", currentDirectory: cwd)
        case .shell, .script:
            // always zsh: the shell integration (ZDOTDIR hooks) depends on it
            view.startProcess(executable: "/bin/zsh", args: ["-l"], environment: envArray, execName: "-zsh", currentDirectory: cwd)
        }

        if case .claude = kind {} else {
            view.getTerminal().registerOscHandler(code: ShellIntegration.oscCode) { [weak self] bytes in
                let msg = String(decoding: bytes, as: UTF8.self)
                DispatchQueue.main.async { self?.handleShellEvent(msg) }
            }
        }
        if case .script(let dir, _, let c) = kind {
            busy = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.run(c, in: dir) }
        }
        if case .claude(let resume) = kind {
            if let r = resume {
                let p = ClaudeData.projectDir(for: cwd) + "/\(r).jsonl"
                if FileManager.default.fileExists(atPath: p) { transcriptPath = p }
            }
            claudeStartedAt = startedAt
            startPolling()
        }
    }

    private func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.poll() }
    }

    deinit {
        timer?.invalidate()
        if let t = transcriptPath { ClaudeData.claimedTranscripts.remove(t) }
    }

    func terminate() {
        timer?.invalidate()
        view.terminate()
    }

    var shellPid: pid_t { view.process?.shellPid ?? 0 }

    /// "start;<cmd>" or "end;<exit>" from the zsh hooks.
    private func handleShellEvent(_ msg: String) {
        let parts = msg.split(separator: ";", maxSplits: 1).map(String.init)
        switch parts.first {
        case "start":
            busy = true
            lastCommand = parts.count > 1 ? parts[1] : ""
            lastExit = nil
            if lastCommand.range(of: #"^\s*claude(\s|$)"#, options: .regularExpression) != nil {
                claudeRunning = true
                claudeStartedAt = Date()
                transcriptPath = nil; offset = 0
                events = []; files = [:]; backups = [:]; bashDiffs = [:]; runningTools = []
                inputTokens = 0; outputTokens = 0
                planPath = nil; planText = ""; planMode = false; permissionMode = nil
                claudeReusesTranscript = lastCommand.contains("--continue") || lastCommand.contains("--resume") || lastCommand.contains(" -c") || lastCommand.contains(" -r")
                if let m = lastCommand.range(of: #"(--resume|-r)\s+(\S+)"#, options: .regularExpression) {
                    let id = lastCommand[m].split(separator: " ").last.map(String.init) ?? ""
                    let p = ClaudeData.projectDir(for: cwd) + "/\(id).jsonl"
                    if FileManager.default.fileExists(atPath: p) { transcriptPath = p }
                }
                let name = (cwd as NSString).lastPathComponent
                title = "✳ \(name)"
                startPolling()
            }
        case "end":
            busy = false
            lastExit = parts.count > 1 ? Int32(parts[1]) : nil
            if claudeRunning {
                claudeRunning = false
                timer?.invalidate(); timer = nil
                title = (cwd as NSString).lastPathComponent
            }
        default: break
        }
    }

    /// Types a command into the interactive shell (cd first if needed).
    func run(_ command: String, in dir: String) {
        let prefix = dir == cwd ? "" : "cd \(shellQuote(dir)) && "
        cwd = dir
        view.send(txt: "\u{15}" + prefix + command + "\n")   // ^U clears any pending input
        busy = true
    }

    /// Turns this idle shell into a script tab and runs the script.
    func reuse(forScript dir: String, name: String, command: String, projectName: String) {
        kind = .script(dir: dir, name: name, command: command)
        title = "\(name) · \(projectName)"
        run(command, in: dir)
    }

    private func poll() {
        if transcriptPath == nil {
            transcriptPath = ClaudeData.newestTranscript(for: cwd, after: claudeStartedAt.addingTimeInterval(-2), allowExisting: claudeReusesTranscript)
        }
        if let path = transcriptPath {
            let u = ClaudeData.readEvents(path: path, offset: &offset)
            if !u.isEmpty {
                if !u.events.isEmpty && attention != nil { attention = nil; app?.refreshDockBadge() }
                events.append(contentsOf: u.events)
                if events.count > 500 { events.removeFirst(events.count - 500) }
                inputTokens += u.inputTokens
                outputTokens += u.outputTokens
                for e in u.events where e.file != nil && !e.file!.hasPrefix(ClaudeData.plansDir) {
                    files[e.file!, default: 0] += 1
                }
                for (path, d) in u.bashDiffs { bashDiffs[path, default: []] += d }
                for (path, b) in u.backups {
                    if let e = backups[path], e.version <= b.version { continue }
                    backups[path] = b
                    if files[path] == nil { files[path] = 0 }
                }
                if let m = u.planMode { planMode = m }
                if let p = u.planPath, p != planPath { planPath = p; planModified = nil }
                if let t = u.aiTitle, !t.isEmpty { title = t }
                if let pm = u.permissionMode { permissionMode = pm }
                if !u.startedTools.isEmpty || !u.finishedTools.isEmpty {
                    var tools = runningTools + u.startedTools
                    let done = Set(u.finishedTools)
                    tools.removeAll { done.contains($0.id) }
                    runningTools = tools
                }
            }
        }
        refreshPlan()
    }

    func setPlan(_ path: String?) {
        planPath = path
        planModified = nil
        refreshPlan()
    }

    private func refreshPlan() {
        guard let p = planPath else { if !planText.isEmpty { planText = "" }; return }
        let mod = (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date
        guard mod != planModified else { return }
        planModified = mod
        planText = (try? String(contentsOfFile: p, encoding: .utf8)) ?? ""
    }

    // MARK: LocalProcessTerminalViewDelegate
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        guard !title.isEmpty else { return }
        if case .script = kind { return }
        DispatchQueue.main.async { self.title = title }
    }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        guard let d = directory, let url = URL(string: d) else { return }
        let path = url.path
        DispatchQueue.main.async { if !path.isEmpty && path != self.cwd { self.cwd = path } }
    }
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { self.alive = false; self.busy = false; self.claudeRunning = false }
    }
}

/// One open folder: its own file browser, terminal tabs and npm packages.
final class Project: ObservableObject, Identifiable {
    let id = UUID()
    @Published var root: String?              // nil = blank project (welcome screen)
    @Published var sessions: [TerminalSession] = []
    @Published var currentId: UUID?
    @Published var selectedFolder: String
    @Published var selectedPath: String?
    @Published var packages: [NpmProject] = []
    @Published var activePackage: String?
    @Published var links: [LinkedProject] = []
    @Published var linkError: String?
    weak var app: AppState?

    var name: String { root.map { ($0 as NSString).lastPathComponent } ?? "Nouveau projet" }
    var current: TerminalSession? { sessions.first { $0.id == currentId } }

    init(root: String?) {
        self.root = root
        selectedFolder = root ?? NSHomeDirectory()
        expandedRoot = root
        if let r = root { links = LinkStore.load(root: r); reloadPackages() }
    }

    // MARK: links
    func addLink(_ dir: String) {
        guard !links.contains(where: { $0.path == dir }) else { return }
        links.append(LinkedProject(path: dir))
    }
    func removeLink(_ l: LinkedProject) { links.removeAll { $0.path == l.path } }
    func saveLinks() {
        guard let r = root else { return }
        do { try LinkStore.save(root: r, links: links); linkError = nil } catch { linkError = error.localizedDescription }
        reloadPackages()
    }
    /// Every root the browser may show: project + linked.
    var allRoots: [String] { (root.map { [$0] } ?? []) + links.map(\.path) }

    func setRoot(_ dir: String) {
        root = dir
        selectedFolder = dir
        selectedPath = nil
        navRoot = [:]; navHistory = [:]; expandedRoot = dir
        links = LinkStore.load(root: dir)
        reloadPackages()
        app?.persist()
        app?.addRecent(dir)
    }

    // MARK: tabs
    func newClaudeTab(resume: String? = nil, cwd: String? = nil) {
        add(TerminalSession(cwd: cwd ?? selectedFolder, kind: .claude(resume: resume), projectRoot: root))
    }
    func newShellTab(cwd: String? = nil) {
        add(TerminalSession(cwd: cwd ?? selectedFolder, kind: .shell, projectRoot: root))
    }
    private func add(_ s: TerminalSession) {
        s.app = app
        if let f = app?.terminalFont { s.view.font = f }
        sessions.append(s)
        currentId = s.id
    }
    func close(_ s: TerminalSession) {
        s.terminate()
        guard let idx = sessions.firstIndex(where: { $0.id == s.id }) else { return }
        sessions.remove(at: idx)
        if currentId == s.id { currentId = sessions[safe: min(idx, sessions.count - 1)]?.id }
    }
    func closeAll() { sessions.forEach { $0.terminate() }; sessions = []; currentId = nil }
    func closeCurrentTab() { if let c = current { close(c) } }
    func cycleTab(_ delta: Int) {
        guard !sessions.isEmpty, let idx = sessions.firstIndex(where: { $0.id == currentId }) else { return }
        currentId = sessions[(idx + delta + sessions.count) % sessions.count].id
    }
    /// An alive shell/script tab with nothing running in it. Current tab first.
    func idleShell() -> TerminalSession? {
        let idle = sessions.filter { $0.alive && !$0.isClaude && !$0.busy }
        return idle.first { $0.id == currentId } ?? idle.first
    }
    /// Types a file path into the current terminal (creates a Claude tab if none).
    func insertPath(_ path: String) {
        if current == nil { newClaudeTab(cwd: (path as NSString).deletingLastPathComponent) }
        guard let s = current else { return }
        Attachments.send(paths: [path], to: s.view)
        s.view.window?.makeFirstResponder(s.view)
    }

    // MARK: Finder navigation, one state per root (project + linked), bounded to that root
    @Published var expandedRoot: String?
    @Published var bottomCollapsed = UserDefaults.standard.bool(forKey: "bottomCollapsed") {
        didSet { UserDefaults.standard.set(bottomCollapsed, forKey: "bottomCollapsed") }
    }
    @Published var bottomMode: String = UserDefaults.standard.string(forKey: "bottomMode") ?? "links" {
        didSet { UserDefaults.standard.set(bottomMode, forKey: "bottomMode") }
    }
    @Published var sessionCollapsed = UserDefaults.standard.bool(forKey: "sessionCollapsed") {
        didSet { UserDefaults.standard.set(sessionCollapsed, forKey: "sessionCollapsed") }
    }
    @Published var sessionMode: String = UserDefaults.standard.string(forKey: "sessionMode") ?? "plan" {
        didSet { UserDefaults.standard.set(sessionMode, forKey: "sessionMode") }
    }
    @Published var navRoot: [String: String] = [:]       // root -> folder shown
    @Published var navHistory: [String: [String]] = [:]

    func shownFolder(for root: String) -> String { navRoot[root] ?? root }
    func navigate(to dir: String, in root: String) {
        guard dir == root || dir.hasPrefix(root + "/"), dir != shownFolder(for: root) else { return }
        navHistory[root, default: []].append(shownFolder(for: root))
        navRoot[root] = dir
        selectedFolder = dir
        selectedPath = nil
    }
    func navigateBack(in root: String) {
        guard let prev = navHistory[root]?.popLast() else { return }
        navRoot[root] = prev
        selectedFolder = prev
        selectedPath = nil
    }
    func canGoUp(in root: String) -> Bool { shownFolder(for: root) != root }
    func navigateUp(in root: String) {
        guard canGoUp(in: root) else { return }
        navigate(to: (shownFolder(for: root) as NSString).deletingLastPathComponent, in: root)
    }
    /// Root owning a path (project or linked).
    func owningRoot(of path: String) -> String? {
        allRoots.first { path == $0 || path.hasPrefix($0 + "/") }
    }

    // MARK: npm packages (root + workspaces)
    func reloadPackages() {
        guard let r = root else { packages = []; return }
        var list: [NpmProject] = []
        if let main = NpmProject.load(dir: r) {
            list.append(main)
            for ws in main.workspaces {
                for dir in Project.expand(pattern: ws, in: r) {
                    if let p = NpmProject.load(dir: dir) { list.append(p) }
                }
            }
        }
        for l in links {
            if let p = NpmProject.load(dir: l.path) { list.append(p) }
        }
        packages = list
        if activePackage == nil || !list.contains(where: { $0.dir == activePackage }) { activePackage = list.first?.dir }
    }
    /// Expands "packages/*" style workspace globs (one wildcard segment max).
    private static func expand(pattern: String, in root: String) -> [String] {
        let fm = FileManager.default
        let parts = pattern.split(separator: "/").map(String.init)
        var dirs = [root]
        for part in parts {
            var next: [String] = []
            for d in dirs {
                if part.contains("*") {
                    let regex = "^" + NSRegularExpression.escapedPattern(for: part).replacingOccurrences(of: "\\*", with: ".*") + "$"
                    for n in (try? fm.contentsOfDirectory(atPath: d)) ?? [] where n.range(of: regex, options: .regularExpression) != nil && !n.hasPrefix(".") {
                        next.append(d + "/" + n)
                    }
                } else { next.append(d + "/" + part) }
            }
            dirs = next
        }
        return dirs.filter { var b: ObjCBool = false; return fm.fileExists(atPath: $0, isDirectory: &b) && b.boolValue }
    }
    func runningScript(dir: String, name: String) -> TerminalSession? {
        sessions.first { s in
            if case .script(let d, let n, _) = s.kind, s.alive, s.busy { return d == dir && n == name }
            return false
        }
    }
    /// name == nil runs the install command. Reuses an idle shell tab when possible.
    func runScript(package: NpmProject, name: String?) {
        let n = name ?? "install"
        if let r = runningScript(dir: package.dir, name: n) { currentId = r.id; return }
        let cmd = name.map { package.command(for: $0) } ?? package.installCommand
        if let idle = idleShell() {
            idle.reuse(forScript: package.dir, name: n, command: cmd, projectName: package.name)
            currentId = idle.id
        } else {
            add(TerminalSession(cwd: package.dir, kind: .script(dir: package.dir, name: n, command: cmd), projectRoot: root))
        }
    }
}

final class AppState: ObservableObject {
    @Published var projects: [Project] = []
    @Published var activeId: UUID?
    @Published var recent: [String] = UserDefaults.standard.stringArray(forKey: "recentProjects") ?? []
    @Published var showLeft = true
    @Published var showRight = true
    @Published var editingSkill: SkillInfo?
    @Published var skillsVersion = 0
    @Published var mcpHealth: [String: MCPServer.Health] = [:]
    @Published var fontName: String = UserDefaults.standard.string(forKey: "fontName") ?? "" {
        didSet { UserDefaults.standard.set(fontName, forKey: "fontName"); applyFont() }
    }
    @Published var fontSize: Double = UserDefaults.standard.double(forKey: "fontSize") == 0 ? 13 : UserDefaults.standard.double(forKey: "fontSize") {
        didSet { UserDefaults.standard.set(fontSize, forKey: "fontSize"); applyFont() }
    }

    var active: Project? { projects.first { $0.id == activeId } }
    var allSessions: [TerminalSession] { projects.flatMap(\.sessions) }

    init() {
        let saved = UserDefaults.standard.stringArray(forKey: "openProjects") ?? []
        for dir in saved where FileManager.default.fileExists(atPath: dir) { _ = openProject(dir, persist: false) }
        if projects.isEmpty { newBlankProject() }
        activeId = projects.first?.id
    }

    // MARK: projects
    @discardableResult
    func openProject(_ dir: String, persist: Bool = true) -> Project {
        if let existing = projects.first(where: { $0.root == dir }) { activeId = existing.id; return existing }
        let p: Project
        if let blank = active, blank.root == nil {
            p = blank; p.setRoot(dir)          // setRoot persists + records recent
            activeId = p.id
            return p
        } else {
            p = Project(root: dir); p.app = self
            projects.append(p)
        }
        activeId = p.id
        if persist { addRecent(dir); self.persist() }
        return p
    }
    func newBlankProject() {
        let p = Project(root: nil); p.app = self
        projects.append(p)
        activeId = p.id
    }
    func closeProject(_ p: Project) {
        p.closeAll()
        guard let idx = projects.firstIndex(where: { $0.id == p.id }) else { return }
        projects.remove(at: idx)
        if projects.isEmpty { newBlankProject() }
        else if activeId == p.id { activeId = projects[min(idx, projects.count - 1)].id }
        persist()
    }
    func cycleProject(_ delta: Int) {
        guard let idx = projects.firstIndex(where: { $0.id == activeId }) else { return }
        activeId = projects[(idx + delta + projects.count) % projects.count].id
    }
    func persist() {
        UserDefaults.standard.set(projects.compactMap(\.root), forKey: "openProjects")
    }
    func addRecent(_ dir: String) {
        recent.removeAll { $0 == dir }
        recent.insert(dir, at: 0)
        recent = Array(recent.prefix(15))
        UserDefaults.standard.set(recent, forKey: "recentProjects")
    }
    /// Jumps to the project and tab owning a session.
    func focus(_ s: TerminalSession) {
        if let p = projects.first(where: { $0.sessions.contains { $0.id == s.id } }) {
            activeId = p.id
            p.currentId = s.id
        }
        clearAttention(s)
    }

    func clearAttention(_ s: TerminalSession) {
        guard s.attention != nil else { return }
        s.attention = nil
        refreshDockBadge()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [s.id.uuidString])
    }

    var attentionCount: Int { allSessions.filter { $0.attention != nil }.count }

    func refreshDockBadge() {
        let n = EventHub.dockBadgeEnabled ? attentionCount : 0
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    }

    /// Called when the app or a tab becomes visible.
    func currentTabShown() {
        guard NSApp.isActive, let s = active?.current else { return }
        clearAttention(s)
    }
    func chooseFolder(for project: Project? = nil) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = L("Ouvrir le projet")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if let p = project, p.root == nil { p.setRoot(url.path); activeId = p.id }
        else { openProject(url.path) }
    }

    // MARK: skills
    func insertSkill(_ s: SkillInfo) {
        guard let p = active else { return }
        if p.current == nil { p.newClaudeTab() }
        guard let t = p.current else { return }
        t.view.send(txt: "/\(s.name) ")
        t.view.window?.makeFirstResponder(t.view)
    }
    /// Types a prompt into the current Claude tab (opens one if the current tab isn't Claude).
    func sendToClaude(_ prompt: String) {
        guard let p = active else { return }
        if !(p.current?.isClaude ?? false) { p.newClaudeTab() }
        guard let t = p.current else { return }
        let delay: TimeInterval = t.isClaude && t.events.isEmpty && t.transcriptPath == nil ? 2.5 : 0.2
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            t.view.send(txt: prompt)
            t.view.window?.makeFirstResponder(t.view)
        }
    }

    // MARK: fonts
    let monoFonts: [String] = {
        var names = NSFontManager.shared.availableFontFamilies.filter { fam in
            guard let f = NSFont(name: fam, size: 12) else { return false }
            return f.isFixedPitch
        }
        names.sort()
        return ["", "JetBrains Mono", "Menlo", "SF Mono"].filter { $0.isEmpty || names.contains($0) || $0 == "SF Mono" }
            + names.filter { !["JetBrains Mono", "Menlo", "SF Mono"].contains($0) }
    }()
    var terminalFont: NSFont {
        let size = CGFloat(fontSize)
        if !fontName.isEmpty, let f = NSFont(name: fontName, size: size) { return f }
        return NSFont(name: "JetBrainsMono-Regular", size: size)
            ?? NSFont(name: "SFMono-Regular", size: size)
            ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }
    private func applyFont() {
        let f = terminalFont
        allSessions.forEach { $0.view.font = f }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
