import Foundation
import Testing
@testable import ClaudeTerm

struct ClaudeDataTests {
    @Test func testEncodeMatchesClaudeCodeASCIIRule() {
        #expect(ClaudeData.encode("/Users/jerome") == "-Users-jerome")
        #expect(ClaudeData.encode("/Users/jerome/dev/turf-v2") == "-Users-jerome-dev-turf-v2")
        // Claude Code replaces every non [a-zA-Z0-9] byte, accented letters included
        #expect(ClaudeData.encode("/Users/j/développement") == "-Users-j-d-veloppement")
        #expect(ClaudeData.encode("/a b.c_d") == "-a-b-c-d")
    }

    @Test func testReadEventsParsesToolsUsageAndMetadata() {
        let tmp = TempDir()
        let path = tmp.write("s.jsonl", jsonl([
            ["type": "user", "timestamp": "2026-09-19T10:00:00.000Z", "message": ["role": "user", "content": "fais un truc"]],
            ["type": "assistant", "timestamp": "2026-09-19T10:00:01.000Z", "message": ["role": "assistant",
                "usage": ["input_tokens": 100, "output_tokens": 20],
                "content": [
                    ["type": "text", "text": "ok"],
                    ["type": "tool_use", "id": "t1", "name": "Edit", "input": ["file_path": "/p/a.swift"]],
                    ["type": "tool_use", "id": "t2", "name": "Bash", "input": ["command": "ls -la"]],
                ]]],
            ["type": "user", "timestamp": "2026-09-19T10:00:02.000Z", "message": ["role": "user",
                "content": [["type": "tool_result", "tool_use_id": "t1", "content": "done"]]]],
            ["type": "ai-title", "aiTitle": "Mon titre", "sessionId": "x"],
            ["type": "permission-mode", "permissionMode": "auto", "sessionId": "x"],
            ["type": "attachment", "attachment": ["type": "plan_mode", "planFilePath": "/plans/p.md"]],
        ]))
        var offset: UInt64 = 0
        let u = ClaudeData.readEvents(path: path, offset: &offset)

        #expect(u.events.map(\.kind) == ["user", "text", "Edit", "Bash"])
        #expect(u.events[2].file == "/p/a.swift")
        #expect(u.events[3].detail == "ls -la")
        #expect(u.inputTokens == 100)
        #expect(u.outputTokens == 20)
        #expect(u.startedTools.map(\.id) == ["t1", "t2"])
        #expect(u.finishedTools == ["t1"])
        #expect(u.aiTitle == "Mon titre")
        #expect(u.permissionMode == "auto")
        #expect(u.planPath == "/plans/p.md")
        #expect(u.planMode == true)
        #expect(offset > 0)

        // second read: nothing new
        let again = ClaudeData.readEvents(path: path, offset: &offset)
        #expect(again.isEmpty)
    }

    @Test func testReadEventsOnlyConsumesCompleteLines() {
        let tmp = TempDir()
        let full = jsonl([["type": "user", "message": ["role": "user", "content": "a"]]])
        let path = tmp.write("s.jsonl", full + "{\"type\":\"user\",\"mess")   // truncated tail
        var offset: UInt64 = 0
        let u = ClaudeData.readEvents(path: path, offset: &offset)
        #expect(u.events.count == 1)
        #expect(offset == UInt64(full.utf8.count), Comment(rawValue: "offset must stop before the partial line"))
    }

    @Test func testToolResultOnlyUpdateIsNotEmpty() {
        let tmp = TempDir()
        let path = tmp.write("s.jsonl", jsonl([
            ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "t9"]]]],
        ]))
        var offset: UInt64 = 0
        let u = ClaudeData.readEvents(path: path, offset: &offset)
        #expect(u.events.isEmpty)
        #expect(!(u.isEmpty), Comment(rawValue: "finished tools must not be dropped"))
        #expect(u.finishedTools == ["t9"])
    }

    @Test func testIgnoresSystemStyleUserMessages() {
        let tmp = TempDir()
        let path = tmp.write("s.jsonl", jsonl([
            ["type": "user", "message": ["role": "user", "content": "<command-name>/clear</command-name>"]],
            ["type": "user", "message": ["role": "user", "content": "vrai message"]],
        ]))
        var offset: UInt64 = 0
        let u = ClaudeData.readEvents(path: path, offset: &offset)
        #expect(u.events.map(\.detail) == ["vrai message"])
    }
}

struct FileHistoryTests {
    @Test func testSnapshotBackupsKeepEarliestVersion() {
        let tmp = TempDir()
        let path = tmp.write("s.jsonl", jsonl([
            ["type": "file-history-snapshot", "snapshot": ["trackedFileBackups": [
                "Documents/p/a.swift": ["backupFileName": "h1@v3", "version": 3, "realParentDir": "/Users/x/Documents/p"],
            ]]],
            ["type": "file-history-snapshot", "snapshot": ["trackedFileBackups": [
                "Documents/p/a.swift": ["backupFileName": "h1@v1", "version": 1, "realParentDir": "/Users/x/Documents/p"],
                "Documents/p/b.swift": ["backupFileName": "h2@v2", "version": 2, "realParentDir": "/Users/x/Documents/p"],
            ]]],
        ]))
        var offset: UInt64 = 0
        let u = ClaudeData.readEvents(path: path, offset: &offset)
        #expect(u.backups["/Users/x/Documents/p/a.swift"]?.name == "h1@v1")
        #expect(u.backups["/Users/x/Documents/p/b.swift"]?.version == 2)
        #expect(!u.isEmpty)
    }

    @Test func testDiffAgainstBackupAndStats() throws {
        let tmp = TempDir()
        let sid = "sess"
        let hist = tmp.write("file-history/\(sid)/h@v1", "a\nb\nc\n")
        let cur = tmp.write("cur.txt", "a\nB\nc\nd\n")
        // use the real implementation with a temporary file-history root via a symlink-free path
        let diff = try runDiff(original: hist, current: cur)
        let (add, rem) = ClaudeData.diffStats(diff)
        #expect(add == 2)
        #expect(rem == 1)
        #expect(diff.contains("+B") && diff.contains("-b") && diff.contains("+d"))
    }

    private func runDiff(original: String, current: String) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/diff")
        p.arguments = ["-u", original, current]
        let out = Pipe(); p.standardOutput = out
        try p.run()
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: d, as: UTF8.self)
    }
}
