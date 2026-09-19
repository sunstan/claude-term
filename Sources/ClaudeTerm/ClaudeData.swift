import Foundation

struct ClaudeSessionInfo: Identifiable {
    let id: String
    let path: String
    let title: String
    let modified: Date
    var projectPath: String = ""
    var messageCount: Int = 0
    var gitBranch: String = ""
}

struct TranscriptUpdate {
    var events: [ToolEvent] = []
    var inputTokens = 0
    var outputTokens = 0
    var planPath: String?
    var planMode: Bool?
    var aiTitle: String?
    var permissionMode: String?
    var startedTools: [(id: String, name: String, detail: String)] = []
    var finishedTools: [String] = []
    /// absolute path → (backup file name, version) from file-history-snapshot records
    var backups: [String: (name: String, version: Int)] = [:]
    /// absolute path → unified-diff hunks of edits made through Bash commands (toolUseResult.bashEditDiff)
    var bashDiffs: [String: [String]] = [:]
    var isEmpty: Bool {
        events.isEmpty && inputTokens == 0 && outputTokens == 0 && planPath == nil
            && planMode == nil && aiTitle == nil && permissionMode == nil
            && startedTools.isEmpty && finishedTools.isEmpty && backups.isEmpty && bashDiffs.isEmpty
    }
}

struct PlanInfo: Identifiable {
    let path: String
    let title: String
    let modified: Date
    var id: String { path }
}

struct ToolEvent: Identifiable {
    let id = UUID()
    let time: Date
    let kind: String      // tool name or "text"
    let detail: String
    let file: String?
}

enum ClaudeData {
    static let root = NSHomeDirectory() + "/.claude/projects"
    static let settingsPath = NSHomeDirectory() + "/.claude/settings.json"
    static let plansDir = NSHomeDirectory() + "/.claude/plans"
    static let fileHistoryDir = NSHomeDirectory() + "/.claude/file-history"

    /// Unified diff between the session's earliest backup of `path` (or nothing) and the file on disk.
    static func sessionDiff(path: String, backupName: String?, sessionId: String) -> String {
        let fm = FileManager.default
        var original = "/dev/null"
        if let b = backupName {
            let bp = fileHistoryDir + "/" + sessionId + "/" + b
            if fm.fileExists(atPath: bp) { original = bp }
        }
        let current = fm.fileExists(atPath: path) ? path : "/dev/null"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/diff")
        p.arguments = ["-u", "--label", "avant", "--label", "après", original, current]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /// (+added, -removed) line counts of a unified diff.
    static func diffStats(_ diff: String) -> (Int, Int) {
        var a = 0, r = 0
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
            if line.hasPrefix("+") { a += 1 } else if line.hasPrefix("-") { r += 1 }
        }
        return (a, r)
    }

    static func plans() -> [PlanInfo] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: plansDir) else { return [] }
        return names.filter { $0.hasSuffix(".md") }.compactMap { n -> PlanInfo? in
            let p = plansDir + "/" + n
            let mod = (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date ?? .distantPast
            let first = (try? String(contentsOfFile: p, encoding: .utf8))?
                .split(separator: "\n").first(where: { $0.hasPrefix("#") })
                .map { $0.drop(while: { $0 == "#" || $0 == " " }) }
            return PlanInfo(path: p, title: first.map(String.init) ?? n, modified: mod)
        }.sorted { $0.modified > $1.modified }
    }

    static func encode(_ path: String) -> String {
        path.map { ($0.isASCII && ($0.isLetter || $0.isNumber)) ? String($0) : "-" }.joined()
    }

    static func projectDir(for cwd: String) -> String { root + "/" + encode(cwd) }

    /// Encoded names of project dirs that contain at least one transcript (cached, refreshed every 10 s).
    private static var projectsWithSessions: Set<String> = []
    private static var projectsChecked = Date.distantPast
    static func hasSessions(_ cwd: String) -> Bool {
        if Date().timeIntervalSince(projectsChecked) > 10 {
            projectsChecked = Date()
            var set = Set<String>()
            for d in (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [] {
                if (try? FileManager.default.contentsOfDirectory(atPath: root + "/" + d))?.contains(where: { $0.hasSuffix(".jsonl") }) == true {
                    set.insert(d)
                }
            }
            projectsWithSessions = set
        }
        return projectsWithSessions.contains(encode(cwd))
    }

    /// Sessions started in `cwd` or any folder below it.
    static func sessions(for cwd: String) -> [ClaudeSessionInfo] {
        let prefix = encode(cwd)
        guard let dirs = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        return dirs.filter { $0 == prefix || $0.hasPrefix(prefix + "-") }
            .flatMap { sessions(inProjectDir: root + "/" + $0, fallbackProject: $0 == prefix ? cwd : nil) }
            .filter { $0.projectPath == cwd || $0.projectPath.hasPrefix(cwd + "/") }
            .sorted { $0.modified > $1.modified }
    }

    /// Sessions of every project, newest first.
    static func allSessions() -> [ClaudeSessionInfo] {
        guard let dirs = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        return dirs.flatMap { sessions(inProjectDir: root + "/" + $0, fallbackProject: nil) }
            .sorted { $0.modified > $1.modified }
    }

    /// Real cwd, read from the transcript's own records (index may be missing).
    private static var cwdCache: [String: String] = [:]
    private static func transcriptCwd(path: String) -> String? {
        if let c = cwdCache[path] { return c }
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { h.closeFile() }
        let s = String(decoding: h.readData(ofLength: 64 * 1024), as: UTF8.self)
        for line in s.split(separator: "\n") {
            if let c = json(line)?["cwd"] as? String, c.hasPrefix("/") { cwdCache[path] = c; return c }
        }
        return nil
    }

    private static func sessions(inProjectDir dir: String, fallbackProject: String?) -> [ClaudeSessionInfo] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        // sessions-index.json gives cheap metadata for most sessions
        var index: [String: [String: Any]] = [:]
        if let d = FileManager.default.contents(atPath: dir + "/sessions-index.json"),
           let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
           let entries = obj["entries"] as? [[String: Any]] {
            for e in entries { if let id = e["sessionId"] as? String { index[id] = e } }
        }
        var out: [ClaudeSessionInfo] = []
        for n in names where n.hasSuffix(".jsonl") {
            let id = String(n.dropLast(6))
            let p = dir + "/" + n
            let attrs = try? FileManager.default.attributesOfItem(atPath: p)
            let mod = attrs?[.modificationDate] as? Date ?? .distantPast
            let e = index[id]
            if e?["isSidechain"] as? Bool == true { continue }
            let title = cachedTitle(path: p, mtime: mod) { aiTitle(path: p) ?? (e?["firstPrompt"] as? String) ?? firstUserText(path: p) ?? "(sans titre)" }
            let projectPath = (e?["projectPath"] as? String) ?? transcriptCwd(path: p) ?? fallbackProject ?? ""
            out.append(ClaudeSessionInfo(
                id: id, path: p, title: String(title.prefix(120)), modified: mod,
                projectPath: projectPath,
                messageCount: e?["messageCount"] as? Int ?? 0,
                gitBranch: e?["gitBranch"] as? String ?? ""))
        }
        return out.sorted { $0.modified > $1.modified }
    }

    private static var titleCache: [String: (mtime: Date, title: String)] = [:]
    private static func cachedTitle(path: String, mtime: Date, compute: () -> String) -> String {
        if let c = titleCache[path], c.mtime == mtime { return c.title }
        let t = compute()
        titleCache[path] = (mtime, t)
        return t
    }

    private static func aiTitle(path: String) -> String? {
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { h.closeFile() }
        let size = h.seekToEndOfFile()
        let chunk: UInt64 = 128 * 1024
        h.seek(toFileOffset: size > chunk ? size - chunk : 0)
        let s = String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
        for line in s.split(separator: "\n").reversed() where line.contains("\"type\":\"ai-title\"") {
            if let t = json(line)?["aiTitle"] as? String, !t.isEmpty { return t }
        }
        return nil
    }

    private static func firstUserText(path: String) -> String? {
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { h.closeFile() }
        let s = String(decoding: h.readData(ofLength: 64 * 1024), as: UTF8.self)
        for line in s.split(separator: "\n") {
            guard let obj = json(line), obj["type"] as? String == "user",
                  let msg = obj["message"] as? [String: Any] else { continue }
            if let t = textOf(msg["content"]), !t.hasPrefix("<"), !t.contains("<command-") {
                return String(t.prefix(90)).replacingOccurrences(of: "\n", with: " ")
            }
        }
        return nil
    }

    /// Moves a session's transcript (and its companion folder) to the Trash and drops it from sessions-index.json.
    static func deleteSession(_ s: ClaudeSessionInfo) throws {
        let fm = FileManager.default
        let dir = (s.path as NSString).deletingLastPathComponent
        try fm.trashItem(at: URL(fileURLWithPath: s.path), resultingItemURL: nil)
        let companion = dir + "/" + s.id
        if fm.fileExists(atPath: companion) {
            try? fm.trashItem(at: URL(fileURLWithPath: companion), resultingItemURL: nil)
        }
        let index = dir + "/sessions-index.json"
        if let d = fm.contents(atPath: index),
           var obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
           let entries = obj["entries"] as? [[String: Any]] {
            obj["entries"] = entries.filter { $0["sessionId"] as? String != s.id }
            if let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
                try? out.write(to: URL(fileURLWithPath: index))
            }
        }
    }

    /// Transcripts currently attached to a tab, so two sessions in one cwd don't grab the same file.
    static var claimedTranscripts = Set<String>()

    static func newestTranscript(for cwd: String, after date: Date, allowExisting: Bool = false) -> String? {
        let dir = projectDir(for: cwd)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
        var best: (String, Date)?
        for n in names where n.hasSuffix(".jsonl") {
            let p = dir + "/" + n
            guard !claimedTranscripts.contains(p),
                  let attrs = try? FileManager.default.attributesOfItem(atPath: p) else { continue }
            let stamp = (allowExisting ? attrs[.modificationDate] : attrs[.creationDate]) as? Date ?? .distantPast
            guard stamp > date else { continue }
            if best == nil || stamp > best!.1 { best = (p, stamp) }
        }
        return best?.0
    }

    /// Reads new complete lines from `offset` and returns everything new.
    static func readEvents(path: String, offset: inout UInt64) -> TranscriptUpdate {
        var u = TranscriptUpdate()
        guard let h = FileHandle(forReadingAtPath: path) else { return u }
        defer { h.closeFile() }
        h.seek(toFileOffset: offset)
        let data = h.readDataToEndOfFile()
        guard !data.isEmpty, let s = String(data: data, encoding: .utf8),
              let lastNL = s.lastIndex(of: "\n") else { return u }
        let consumed = s[...lastNL]
        offset += UInt64(consumed.utf8.count)

        for line in consumed.split(separator: "\n") {
            guard let obj = json(line), let type = obj["type"] as? String else { continue }
            let time = ISO8601DateFormatter.shared.date(from: obj["timestamp"] as? String ?? "") ?? Date()
            switch type {
            case "ai-title":
                u.aiTitle = obj["aiTitle"] as? String
            case "file-history-snapshot":
                guard let snap = obj["snapshot"] as? [String: Any],
                      let tracked = snap["trackedFileBackups"] as? [String: [String: Any]] else { continue }
                for (rel, b) in tracked {
                    guard let name = b["backupFileName"] as? String else { continue }
                    let version = b["version"] as? Int ?? 1
                    let parent = b["realParentDir"] as? String ?? NSHomeDirectory() + "/" + (rel as NSString).deletingLastPathComponent
                    let abs = parent + "/" + (rel as NSString).lastPathComponent
                    if let e = u.backups[abs], e.version <= version { continue }
                    u.backups[abs] = (name, version)
                }
            case "permission-mode":
                u.permissionMode = obj["permissionMode"] as? String
            case "attachment":
                guard let a = obj["attachment"] as? [String: Any] else { continue }
                switch a["type"] as? String {
                case "plan_mode":
                    u.planMode = true
                    if let p = a["planFilePath"] as? String { u.planPath = p }
                case "plan_mode_exit":
                    u.planMode = false
                    if let p = a["planFilePath"] as? String { u.planPath = p }
                default: break
                }
            case "assistant":
                guard let msg = obj["message"] as? [String: Any] else { continue }
                if let usage = msg["usage"] as? [String: Any] {
                    u.inputTokens += usage["input_tokens"] as? Int ?? 0
                    u.outputTokens += usage["output_tokens"] as? Int ?? 0
                }
                guard let content = msg["content"] as? [[String: Any]] else { continue }
                for item in content {
                    switch item["type"] as? String {
                    case "tool_use":
                        let name = item["name"] as? String ?? "?"
                        let input = item["input"] as? [String: Any] ?? [:]
                        let file = (input["file_path"] ?? input["notebook_path"]) as? String
                        if let f = file, f.hasPrefix(plansDir + "/") { u.planPath = f }
                        if name == "EnterPlanMode" { u.planMode = true }
                        if name == "ExitPlanMode" { u.planMode = false }
                        let detail = file
                            ?? input["command"] as? String
                            ?? input["pattern"] as? String
                            ?? input["description"] as? String
                            ?? input["prompt"] as? String
                            ?? input["query"] as? String
                            ?? ""
                        u.events.append(ToolEvent(time: time, kind: name, detail: oneLine(detail), file: file))
                        if let tid = item["id"] as? String { u.startedTools.append((tid, name, oneLine(detail))) }
                    case "text":
                        if let t = item["text"] as? String, !t.isEmpty {
                            u.events.append(ToolEvent(time: time, kind: "text", detail: oneLine(t), file: nil))
                        }
                    default: break
                    }
                }
            case "user":
                guard let msg = obj["message"] as? [String: Any] else { continue }
                if let tur = obj["toolUseResult"] as? [String: Any], let bed = tur["bashEditDiff"] as? [String: Any],
                   let files = bed["files"] as? [[String: Any]] {
                    for f in files {
                        guard let path = f["filePath"] as? String else { continue }
                        var text = ""
                        for h in f["hunks"] as? [[String: Any]] ?? [] {
                            text += "@@ -\(h["oldStart"] ?? 0),\(h["oldLines"] ?? 0) +\(h["newStart"] ?? 0),\(h["newLines"] ?? 0) @@\n"
                            text += (h["lines"] as? [String] ?? []).joined(separator: "\n") + "\n"
                        }
                        u.bashDiffs[path, default: []].append(text)
                        u.events.append(ToolEvent(time: time, kind: "Edit (bash)", detail: path, file: path))
                    }
                }
                if let arr = msg["content"] as? [[String: Any]] {
                    for item in arr where item["type"] as? String == "tool_result" {
                        if let tid = item["tool_use_id"] as? String { u.finishedTools.append(tid) }
                    }
                }
                if let t = textOf(msg["content"]), !t.hasPrefix("<") {
                    u.events.append(ToolEvent(time: time, kind: "user", detail: oneLine(t), file: nil))
                }
            default: break
            }
        }
        return u
    }

    private static func oneLine(_ s: String) -> String {
        String(s.replacingOccurrences(of: "\n", with: " ⏎ ").prefix(200))
    }

    private static func textOf(_ content: Any?) -> String? {
        if let s = content as? String { return s }
        if let arr = content as? [[String: Any]] {
            let texts = arr.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            return texts.isEmpty ? nil : texts.joined(separator: " ")
        }
        return nil
    }

    private static func json(_ line: Substring) -> [String: Any]? {
        guard let d = line.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }
}

extension ISO8601DateFormatter {
    static let shared: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
