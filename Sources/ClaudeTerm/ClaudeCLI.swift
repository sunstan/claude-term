import Foundation

/// Locates the `claude` binary. `zsh -l -c` does not read ~/.zshrc, where most users
/// extend PATH, so we cannot rely on the login shell alone.
enum ClaudeCLI {
    static let extraDirs: [String] = [
        NSHomeDirectory() + "/.local/bin",
        NSHomeDirectory() + "/.claude/local",
        NSHomeDirectory() + "/.npm-global/bin",
        NSHomeDirectory() + "/.bun/bin",
        NSHomeDirectory() + "/.volta/bin",
        "/opt/homebrew/bin", "/usr/local/bin",
    ]

    /// PATH with the usual install locations appended (only those that exist).
    static func augmentedPATH(_ base: String?) -> String {
        var parts = (base ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for d in extraDirs where !parts.contains(d) && FileManager.default.fileExists(atPath: d) { parts.append(d) }
        return parts.joined(separator: ":")
    }

    private static var cached: String?

    /// Absolute path of `claude`, or nil if it cannot be found anywhere.
    static func path() -> String? {
        if let c = cached, FileManager.default.isExecutableFile(atPath: c) { return c }
        let fm = FileManager.default
        for d in augmentedPATH(ProcessInfo.processInfo.environment["PATH"]).split(separator: ":") {
            let p = String(d) + "/claude"
            if fm.isExecutableFile(atPath: p) { cached = p; return p }
        }
        // Last resort: an interactive login shell, which does read ~/.zshrc.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-l", "-i", "-c", "command -v claude"]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let s = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map { String($0).trimmingCharacters(in: .whitespaces) }
        if let s, s.hasPrefix("/"), fm.isExecutableFile(atPath: s) { cached = s; return s }
        return nil
    }
}
