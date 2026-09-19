import SwiftUI
import AppKit
import UserNotifications

/// What a Claude tab is waiting for, as reported by Claude Code hooks.
enum Attention: Equatable {
    case permission(String)   // a tool needs approval
    case idle                 // Claude is waiting for input
    case done                 // Claude finished a response (Stop)

    var color: Color {
        switch self { case .permission: return .orange; case .idle: return .yellow; case .done: return .blue }
    }
    var label: String {
        switch self {
        case .permission: return L("Permission en attente")
        case .idle: return L("Claude attend une réponse")
        case .done: return L("Claude a terminé")
        }
    }
}

/// Receives Claude Code hook events through a spool directory and routes them to tabs.
final class EventHub: NSObject, UNUserNotificationCenterDelegate {
    static let shared = EventHub()
    static let dir = NSHomeDirectory() + "/Library/Application Support/ClaudeTerm/events"
    static let script = NSHomeDirectory() + "/Library/Application Support/ClaudeTerm/hook.sh"

    weak var state: AppState?
    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1

    static var notificationsEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "notifyMac") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "notifyMac") }
    }
    static var dockBadgeEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "dockBadge") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "dockBadge") }
    }

    // MARK: hook script + settings.json entries
    static func installScript() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let body = """
        #!/bin/sh
        # ClaudeTerm hook: spools the Claude Code event (JSON on stdin) for the app.
        d="$HOME/Library/Application Support/ClaudeTerm/events"
        mkdir -p "$d"
        cat > "$d/$(date +%s)-$$-$RANDOM.json"
        exit 0
        """
        if (try? String(contentsOfFile: script, encoding: .utf8)) != body {
            try? body.write(toFile: script, atomically: true, encoding: .utf8)
        }
        chmod(script, 0o755)
    }

    static let hookEvents = ["Notification", "Stop"]
    /// Claude Code runs hook commands through `sh -c`, so the path (which contains a space) must be quoted.
    static var hookCommand: String { shellQuote(script) }
    private static func isOurs(_ h: SettingsModel.HookEntry) -> Bool {
        h.command == hookCommand || h.command == script || h.command == "\"\(script)\""
    }

    static func hooksInstalled() -> Bool {
        let m = SettingsModel()
        return hookEvents.allSatisfy { ev in m.hooks.contains { $0.event == ev && $0.command == hookCommand } }
    }

    static func setHooksInstalled(_ on: Bool) throws {
        installScript()
        let m = SettingsModel()
        // drop any previous variant (unquoted…) then re-add
        for h in m.hooks.reversed() where isOurs(h) { m.removeHook(h) }
        if on {
            for ev in hookEvents { m.addHook(event: ev, command: hookCommand) }
        }
        m.save()
        if m.status.hasPrefix("Erreur") || m.status.hasPrefix("Error") {
            throw NSError(domain: "ClaudeTerm", code: 20, userInfo: [NSLocalizedDescriptionKey: m.status])
        }
    }

    // MARK: watching
    func start(state: AppState) {
        self.state = state
        Self.installScript()
        UNUserNotificationCenter.current().delegate = self
        guard source == nil else { return }
        fd = open(Self.dir, O_EVTONLY)
        guard fd >= 0 else { return }
        let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: .main)
        s.setEventHandler { [weak self] in self?.drain() }
        s.setCancelHandler { [fd = self.fd] in close(fd) }
        s.resume()
        source = s
        drain()
    }

    private func drain() {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: Self.dir) else { return }
        for n in names.sorted() where n.hasSuffix(".json") {
            let p = Self.dir + "/" + n
            defer { try? fm.removeItem(atPath: p) }
            guard let d = fm.contents(atPath: p), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            handle(o)
        }
    }

    private func handle(_ o: [String: Any]) {
        guard let state else { return }
        let event = o["hook_event_name"] as? String ?? ""
        let transcript = o["transcript_path"] as? String
        let cwd = o["cwd"] as? String
        let message = o["message"] as? String ?? ""
        let type = o["notification_type"] as? String ?? ""

        let attention: Attention
        switch event {
        case "Stop": attention = .done
        case "Notification":
            if type == "permission_prompt" || message.localizedCaseInsensitiveContains("permission") { attention = .permission(message) }
            else if type == "idle_prompt" || message.localizedCaseInsensitiveContains("waiting") { attention = .idle }
            else { return }   // auth_success and friends: nothing to show
        default: return
        }

        // route to the tab: transcript path first, then cwd
        let sessions = state.allSessions.filter(\.isClaude)
        let target = sessions.first { $0.transcriptPath == transcript }
            ?? sessions.first { cwd != nil && $0.cwd == cwd && $0.transcriptPath == nil }
            ?? sessions.first { cwd != nil && $0.cwd == cwd }
        guard let s = target else { return }
        if s.transcriptPath == nil, let t = transcript { s.transcriptPath = t }

        // visible and app active → no need to nag
        let visible = NSApp.isActive && state.active?.currentId == s.id && state.projects.first { $0.sessions.contains { $0.id == s.id } }?.id == state.activeId
        if visible && attention == .done { return }
        s.attention = attention
        state.refreshDockBadge()
        if !visible && Self.notificationsEnabled { notify(s, attention) }
    }

    private func notify(_ s: TerminalSession, _ a: Attention) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            let c = UNMutableNotificationContent()
            c.title = s.title
            c.body = { if case .permission(let m) = a, !m.isEmpty { return m } else { return a.label } }()
            c.sound = a == .done ? nil : .default
            c.userInfo = ["session": s.id.uuidString]
            c.threadIdentifier = s.id.uuidString
            center.add(UNNotificationRequest(identifier: s.id.uuidString, content: c, trigger: nil))
        }
    }

    // MARK: UNUserNotificationCenterDelegate
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse) async {
        guard let id = r.notification.request.content.userInfo["session"] as? String,
              let s = state?.allSessions.first(where: { $0.id.uuidString == id }) else { return }
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            state?.focus(s)
        }
    }
}
