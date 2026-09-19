import Foundation
import Testing
@testable import ClaudeTerm

struct MCPTests {
    @Test func testWritePreservesOtherKeysAndServers() throws {
        let tmp = TempDir()
        tmp.write("p/.mcp.json", """
        {"mcpServers": {"browsermcp": {"command": "npx", "args": ["@browsermcp/mcp@latest"]}}, "other": {"keep": true}}
        """)
        var s = MCPServer(name: "db")
        s.transport = "http"; s.url = "https://db.example/mcp"; s.headers = ["Authorization": "Bearer x"]; s.env = ["A": "1"]
        try MCPStore.write(s, root: tmp.path + "/p")
        let o = tmp.json("p/.mcp.json")
        #expect((o["other"] as? [String: Bool]) == ["keep": true])
        let servers = o["mcpServers"] as! [String: Any]
        #expect(servers.keys.sorted() == ["browsermcp", "db"])
        let db = servers["db"] as! [String: Any]
        #expect(db["type"] as? String == "http")
        #expect(db["url"] as? String == "https://db.example/mcp")
        #expect((db["headers"] as? [String: String]) == ["Authorization": "Bearer x"])

        let list = MCPStore.projectServers(root: tmp.path + "/p")
        #expect(list.map(\.name) == ["browsermcp", "db"])
        #expect(list[0].transport == "stdio")
        #expect(list[0].summary == "npx @browsermcp/mcp@latest")
        #expect(list[1].transport == "http")

        try MCPStore.remove(name: "browsermcp", root: tmp.path + "/p")
        #expect(MCPStore.projectServers(root: tmp.path + "/p").map(\.name) == ["db"])
    }

    @Test func testWriteRenamesAndRefusesCorruptFile() throws {
        let tmp = TempDir()
        tmp.write("p/.mcp.json", "{\"mcpServers\": {\"old\": {\"command\": \"x\"}}}")
        var s = MCPServer(name: "new"); s.command = "y"
        try MCPStore.write(s, root: tmp.path + "/p", replacing: "old")
        #expect(MCPStore.projectServers(root: tmp.path + "/p").map(\.name) == ["new"])

        tmp.write("q/.mcp.json", "{\"mcpServers\": {")
        #expect(throws: (any Error).self) { try MCPStore.write(s, root: tmp.path + "/q") }
    }

    @Test func testParseList() {
        let out = """
        Checking MCP server health…

        claude.ai Granola: https://mcp.granola.ai/mcp - ! Needs authentication
        claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
        plugin:cloudflare:cloudflare: https://mcp.cloudflare.com/mcp (HTTP) - ! Needs authentication
        browsermcp: npx @browsermcp/mcp@latest - ✘ Failed to connect
        """
        let p = MCPStore.parseList(out)
        #expect(p.map(\.name) == ["claude.ai Granola", "claude.ai Gmail", "plugin:cloudflare:cloudflare", "browsermcp"])
        #expect(p.map(\.health) == [.needsAuth, .connected, .needsAuth, .failed])
        #expect(p[1].target == "https://gmailmcp.googleapis.com/mcp/v1")
    }

    @Test func testAddArgs() {
        var s = MCPServer(name: "br"); s.command = "npx"; s.args = ["-y", "pkg"]; s.env = ["K": "v"]
        #expect(MCPStore.addArgs(s, scope: "user") == ["add", "-s", "user", "-t", "stdio", "-e", "K=v", "br", "--", "npx", "-y", "pkg"])
        var h = MCPServer(name: "api"); h.transport = "http"; h.url = "https://x/mcp"; h.headers = ["Authorization": "Bearer t"]
        #expect(MCPStore.addArgs(h, scope: "local") == ["add", "-s", "local", "-t", "http", "-H", "Authorization: Bearer t", "api", "https://x/mcp"])
    }
}
