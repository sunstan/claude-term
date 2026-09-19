import Foundation
import Testing
@testable import ClaudeTerm

struct SettingsModelTests {
    private func model(_ json: String) -> (SettingsModel, TempDir) {
        let tmp = TempDir()
        let p = tmp.write("settings.json", json)
        return (SettingsModel(path: p), tmp)
    }

    @Test func testHooksAreEditedInPlaceAndOtherDataSurvives() {
        let (m, tmp) = model("""
        {"model": "opus", "hooks": {
          "Stop": [{"hooks": [{"type": "command", "command": "a.sh", "timeout": 120}, {"type": "prompt", "prompt": "check"}]}],
          "PermissionRequest": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "b.sh"}]}]
        }}
        """)
        let stop = m.hooks.first { $0.event == "Stop" }!
        m.setHookCommand(stop, "a2.sh")
        m.setHookMatcher(stop, "Edit")
        m.save()

        let h = tmp.json("settings.json")["hooks"] as! [String: Any]
        let stopGroup = (h["Stop"] as! [[String: Any]])[0]
        let hooks = stopGroup["hooks"] as! [[String: Any]]
        #expect(hooks[0]["command"] as? String == "a2.sh")
        #expect(hooks[0]["timeout"] as? Int == 120, Comment(rawValue: "extra fields preserved"))
        #expect(hooks[1]["type"] as? String == "prompt", Comment(rawValue: "non-command hooks preserved"))
        #expect(stopGroup["matcher"] as? String == "Edit")
        #expect(h["PermissionRequest"] != nil, Comment(rawValue: "other events preserved"))
        #expect(tmp.json("settings.json")["model"] as? String == "opus")
    }

    @Test func testRemoveLastHookRemovesEvent() {
        let (m, _) = model("""
        {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "a.sh"}]}]}}
        """)
        m.removeHook(m.hooks[0])
        #expect(m.hooks.isEmpty)
        #expect(m.root["hooks"] == nil)
    }

    @Test func testAddHookAndStableIds() {
        let (m, _) = model("{}")
        m.addHook(event: "Notification", matcher: "", command: "notify")
        m.addHook(event: "Notification", matcher: "", command: "second")
        #expect(m.hooks.map(\.id) == ["Notification/0/0", "Notification/1/0"])
        #expect(m.hooks.map(\.id) == m.hooks.map(\.id), Comment(rawValue: "ids are deterministic across reads"))
    }

    @Test func testBindingsRemoveEmptyValues() {
        let (m, tmp) = model("{\"model\": \"opus\", \"permissions\": {\"defaultMode\": \"auto\"}}")
        m.string("model").wrappedValue = ""
        m.string("permissions.defaultMode").wrappedValue = ""
        m.save()
        let s = tmp.json("settings.json")
        #expect(s["model"] == nil)
        #expect(s["permissions"] == nil, Comment(rawValue: "empty nested dicts are dropped"))
    }

    @Test func testRawJSONRejectsInvalid() {
        let (m, _) = model("{\"a\": 1}")
        m.rawJSON = "{ nope"
        #expect(m.status == "JSON invalide")
        #expect(m.root["a"] as? Int == 1)
    }
}
