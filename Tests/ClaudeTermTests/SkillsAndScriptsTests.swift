import Foundation
import Testing
@testable import ClaudeTerm

struct SkillsAndScriptsTests {
    @Test func testFrontmatterParsing() {
        let tmp = TempDir()
        let p = tmp.write("SKILL.md", "---\nname: my-skill\ndescription: \"Fait un truc: utile\"\ndisable-model-invocation: true\n---\n# body\n")
        let f = SkillStore.frontmatter(p)
        #expect(f["name"] == "my-skill")
        #expect(f["description"] == "Fait un truc: utile")
        #expect(f["disable-model-invocation"] == "true")
        #expect(SkillStore.frontmatter(tmp.write("plain.md", "# no frontmatter")) == [:])
    }

    @Test func testProjectSkillsListsSkillsAndCommandsWithModes() {
        let tmp = TempDir()
        tmp.write("p/.claude/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: A\nuser-invocable: false\n---\n")
        tmp.write("p/.claude/skills/beta/SKILL.md", "---\nname: beta\ndescription: B\ndisable-model-invocation: true\n---\n")
        tmp.write("p/.claude/commands/old.md", "Ancienne commande")
        let list = SkillStore.projectSkills(root: tmp.path + "/p")
        #expect(list.map(\.name) == ["alpha", "beta", "old"])
        #expect(list[0].autoOnly)
        #expect(list[1].manualOnly)
        #expect(list[2].isCommand)
        #expect(list[2].description == "Ancienne commande")
    }

    @Test func testCreateAndImportSkill() throws {
        let tmp = TempDir()
        let root = tmp.path + "/p"
        let path = try SkillStore.create(name: "rel-notes", description: "Notes", projectRoot: root, extra: "disable-model-invocation: true")
        #expect(path == root + "/.claude/skills/rel-notes/SKILL.md")
        let f = SkillStore.frontmatter(path)
        #expect(f["name"] == "rel-notes")
        #expect(f["disable-model-invocation"] == "true")
        #expect(throws: (any Error).self, Comment(rawValue: "duplicate refused")) { try SkillStore.create(name: "rel-notes", description: "x", projectRoot: root) }

        let raw = tmp.write("Mon Fichier.md", "# Contenu sans frontmatter\n")
        let imported = try SkillStore.importSkill(from: URL(fileURLWithPath: raw), projectRoot: root)
        #expect(imported == root + "/.claude/skills/mon-fichier/SKILL.md")
        #expect(SkillStore.frontmatter(imported)["name"] == "mon-fichier")
        let body = try String(contentsOfFile: imported, encoding: .utf8)
        #expect(body.contains("# Contenu sans frontmatter"))
    }

    @Test func testValidSkillNames() {
        #expect(SkillStore.isValidName("a-b-1"))
        #expect(!(SkillStore.isValidName("A")))
        #expect(!(SkillStore.isValidName("a--b")))
        #expect(!(SkillStore.isValidName("-a")))
        #expect(!(SkillStore.isValidName("")))
    }

    @Test func testNpmProjectDetectsManagerScriptsAndWorkspaces() {
        let tmp = TempDir()
        tmp.write("p/package.json", """
        {"name": "mono", "version": "1.2.3", "scripts": {"zeta": "z", "dev": "vite", "build": "tsc"}, "workspaces": ["packages/*"]}
        """)
        tmp.write("p/pnpm-lock.yaml", "")
        let p = NpmProject.load(dir: tmp.path + "/p")!
        #expect(p.manager == "pnpm")
        #expect(p.scripts.map(\.name) == ["dev", "build", "zeta"], Comment(rawValue: "favorites first, then alphabetical"))
        #expect(p.command(for: "dev") == "pnpm run dev")
        #expect(p.installCommand == "pnpm install")
        #expect(p.workspaces == ["packages/*"])
        #expect(NpmProject.load(dir: tmp.path) == nil)
    }

    @Test func testFindWalksUp() {
        let tmp = TempDir()
        tmp.write("p/package.json", "{\"name\": \"x\"}")
        tmp.write("p/src/deep/file.ts", "")
        #expect(NpmProject.find(from: tmp.path + "/p/src/deep/file.ts")?.dir == tmp.path + "/p")
        #expect(NpmProject.find(from: tmp.path + "/p/src/deep")?.dir == tmp.path + "/p")
    }

    @Test func testShellEscaping() {
        #expect(Attachments.escape("/a b/c(d).png") == "/a\\ b/c\\(d\\).png")
        #expect(shellQuote("it's") == "'it'\\''s'")
    }
}
