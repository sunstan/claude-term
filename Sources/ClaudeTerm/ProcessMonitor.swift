import Foundation

struct ClaudeProcess: Identifiable {
    let pid: Int
    let started: Date
    let elapsed: String
    let cpu: String
    let memMB: Int
    var cwd: String = "?"
    var children: [ChildProcess] = []
    var id: Int { pid }
}

struct ChildProcess: Identifiable {
    let pid: Int
    let command: String
    let cpu: String
    var id: Int { pid }
}

/// Polls `ps`/`lsof` for running Claude Code processes on this Mac.
final class ProcessMonitor: ObservableObject {
    static let shared = ProcessMonitor()
    @Published var processes: [ClaudeProcess] = []
    private var timer: Timer?
    private let queue = DispatchQueue(label: "procmon", qos: .utility)

    private static let lstartFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        return f
    }()

    func start() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        queue.async {
            let result = Self.scan()
            DispatchQueue.main.async { self.processes = result }
        }
    }

    private static func run(_ path: String, _ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = ["LC_ALL": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func scan() -> [ClaudeProcess] {
        let ps = run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,etime=,%cpu=,rss=,command="])
        struct Row { let pid: Int; let ppid: Int; let started: Date; let etime: String; let cpu: String; let rss: Int; let cmd: String }
        var rows: [Row] = []
        for line in ps.split(separator: "\n") {
            // pid ppid "Sat Sep 19 12:17:40 2026" etime cpu rss command...
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count >= 11, let pid = Int(parts[0]), let ppid = Int(parts[1]) else { continue }
            let lstart = parts[2...6].joined(separator: " ")
            let started = lstartFormatter.date(from: lstart) ?? Date()
            let rss = Int(parts[9]) ?? 0
            let cmd = parts[10...].joined(separator: " ")
            rows.append(Row(pid: pid, ppid: ppid, started: started, etime: String(parts[7]), cpu: String(parts[8]), rss: rss, cmd: cmd))
        }
        let isClaude: (String) -> Bool = { c in
            let exe = c.split(separator: " ").first.map(String.init) ?? ""
            return exe == "claude" || exe.hasSuffix("/claude") || exe.hasSuffix("/bin/claude")
        }
        var claude = rows.filter { isClaude($0.cmd) }.map {
            ClaudeProcess(pid: $0.pid, started: $0.started, elapsed: $0.etime, cpu: $0.cpu, memMB: $0.rss / 1024)
        }
        guard !claude.isEmpty else { return [] }

        // children (Bash tool commands, shells, MCP servers…)
        let byPid = Dictionary(uniqueKeysWithValues: rows.map { ($0.pid, $0) })
        for i in claude.indices {
            var kids: [ChildProcess] = []
            var frontier = [claude[i].pid]
            var seen = Set<Int>()
            while let p = frontier.popLast() {
                for r in rows where r.ppid == p && !seen.contains(r.pid) {
                    seen.insert(r.pid)
                    frontier.append(r.pid)
                    let short = r.cmd.replacingOccurrences(of: NSHomeDirectory(), with: "~")
                    if short.hasPrefix("/bin/zsh -c source ~/.claude/shell-snapshots") { continue }
                    kids.append(ChildProcess(pid: r.pid, command: String(short.prefix(120)), cpu: r.cpu))
                }
            }
            claude[i].children = kids
            _ = byPid
        }

        // cwd via lsof
        let pids = claude.map { String($0.pid) }.joined(separator: ",")
        let lsof = run("/usr/sbin/lsof", ["-a", "-p", pids, "-d", "cwd", "-Fn"])
        var current: Int?
        for line in lsof.split(separator: "\n") {
            if line.hasPrefix("p") { current = Int(line.dropFirst()) }
            else if line.hasPrefix("n"), let c = current, let i = claude.firstIndex(where: { $0.pid == c }) {
                claude[i].cwd = String(line.dropFirst())
            }
        }
        return claude.sorted { $0.started > $1.started }
    }
}
