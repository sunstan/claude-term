import Foundation
import Testing
@testable import ClaudeTerm

struct LinkStoreTests {
    @Test func testSaveWritesAbsoluteDenyRulesAndPreservesSettings() throws {
        let tmp = TempDir()
        let root = tmp.path + "/front"
        tmp.write("front/.claude/settings.local.json", """
        {"permissions": {"allow": ["Bash(npm run:*)"], "additionalDirectories": ["/keep/me"]}, "env": {"FOO": "1"}}
        """)
        let links = [LinkedProject(path: "/x/api", role: "backend", readOnly: false),
                     LinkedProject(path: "/x/ds", role: "design system", readOnly: true)]
        try LinkStore.save(root: root, links: links)

        let s = tmp.json("front/.claude/settings.local.json")
        let perms = s["permissions"] as! [String: Any]
        #expect(perms["allow"] as? [String] == ["Bash(npm run:*)"], Comment(rawValue: "user rules preserved"))
        #expect(s["env"] as? [String: String] == ["FOO": "1"], Comment(rawValue: "unrelated keys preserved"))
        #expect(perms["additionalDirectories"] as? [String] == ["/keep/me", "/x/api", "/x/ds"])
        #expect(perms["deny"] as? [String] == ["Edit(///x/ds/**)", "Write(///x/ds/**)"], Comment(rawValue: "absolute paths need //"))

        #expect(LinkStore.load(root: root) == links)
        let prompt = try String(contentsOfFile: LinkStore.promptPath(root: root), encoding: .utf8)
        #expect(prompt.contains("ds (design system) : /x/ds [lecture seule"))
    }

    @Test func testSaveRemovesPreviousLinksCleanly() throws {
        let tmp = TempDir()
        let root = tmp.path + "/p"
        try LinkStore.save(root: root, links: [LinkedProject(path: "/x/a", readOnly: true), LinkedProject(path: "/x/b")])
        try LinkStore.save(root: root, links: [LinkedProject(path: "/x/b")])
        let perms = tmp.json("p/.claude/settings.local.json")["permissions"] as! [String: Any]
        #expect(perms["additionalDirectories"] as? [String] == ["/x/b"])
        #expect(perms["deny"] == nil, Comment(rawValue: "deny rules of the removed read-only link are gone"))
    }

    @Test func testSaveRefusesToOverwriteCorruptSettings() throws {
        let tmp = TempDir()
        let root = tmp.path + "/p"
        let bad = tmp.write("p/.claude/settings.local.json", "{ \"permissions\": { \"allow\": [\"x\"")   // truncated mid-edit
        #expect(throws: (any Error).self) { try LinkStore.save(root: root, links: [LinkedProject(path: "/x/a")]) }
        let after = try String(contentsOfFile: bad, encoding: .utf8)
        #expect(after == "{ \"permissions\": { \"allow\": [\"x\"", Comment(rawValue: "file untouched"))
    }

    @Test func testEmptyLinksRemovesPrompt() throws {
        let tmp = TempDir()
        let root = tmp.path + "/p"
        try LinkStore.save(root: root, links: [LinkedProject(path: "/x/a")])
        #expect(FileManager.default.fileExists(atPath: LinkStore.promptPath(root: root)))
        try LinkStore.save(root: root, links: [])
        #expect(!(FileManager.default.fileExists(atPath: LinkStore.promptPath(root: root))))
    }
}
