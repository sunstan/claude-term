import SwiftUI
import AppKit

struct FolderNode: Identifiable, Hashable {
    let path: String
    let isDir: Bool
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }

    init(path: String, isDir: Bool = true) { self.path = path; self.isDir = isDir }

    var children: [FolderNode]? {
        guard isDir else { return nil }
        return DirectoryCache.shared.children(of: path)
    }

    var icon: NSImage {
        let img = NSWorkspace.shared.icon(forFile: path)
        img.size = NSSize(width: 16, height: 16)
        return img
    }
}

/// Caches directory listings for the outline: SwiftUI re-evaluates `children` on every render.
final class DirectoryCache {
    static let shared = DirectoryCache()
    private var entries: [String: (mtime: Date, checked: Date, nodes: [FolderNode])] = [:]
    private let skip: Set<String> = ["node_modules", "Library", ".git", "build", "DerivedData", ".build"]

    func children(of path: String) -> [FolderNode]? {
        let now = Date()
        if let e = entries[path], now.timeIntervalSince(e.checked) < 2 { return e.nodes }
        let fm = FileManager.default
        let mtime = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date ?? .distantPast
        if let e = entries[path], e.mtime == mtime {
            entries[path]!.checked = now
            return e.nodes
        }
        guard let names = try? fm.contentsOfDirectory(atPath: path) else { return nil }
        var dirs: [FolderNode] = [], files: [FolderNode] = []
        for n in names where !n.hasPrefix(".") && !skip.contains(n) {
            var d: ObjCBool = false
            guard fm.fileExists(atPath: path + "/" + n, isDirectory: &d) else { continue }
            if d.boolValue { dirs.append(FolderNode(path: path + "/" + n, isDir: true)) }
            else { files.append(FolderNode(path: path + "/" + n, isDir: false)) }
        }
        let cmp: (FolderNode, FolderNode) -> Bool = { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let nodes = dirs.sorted(by: cmp) + files.sorted(by: cmp)
        entries[path] = (mtime, now, nodes)
        return nodes
    }
}

struct FileBrowserView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var project: Project
    @State private var showLinks = false
    @State private var showInfo = false

    private var showBottom: Bool { project.root != nil }

    private var infoText: (title: String, body: String) {
        switch project.bottomMode {
        case "links": return (L("Dossiers liés"),
            L("Les autres projets dont celui-ci dépend (API, design system…).\n\nClaude y a accès directement : les chemins sont écrits dans .claude/settings.local.json (additionalDirectories) et un résumé des rôles lui est transmis au lancement. Un dossier en lecture seule ne peut pas être modifié par Claude.\n\nChaque dossier lié a son propre Finder, pour glisser un fichier dans le prompt."))
        case "skills": return (L("Skills du projet"),
            L("Un skill est un fichier .claude/skills/<nom>/SKILL.md : une description qui dit à Claude quand l'utiliser, puis des instructions.\n\nClaude le charge tout seul quand la demande correspond, ou tu le forces avec /nom (bouton ↩). Les skills des dossiers liés apparaissent aussi.\n\nLes skills perso et ceux des plugins sont dans le panneau de droite."))
        case "mcp": return (L("Serveurs MCP du projet"),
            L("Les serveurs MCP déclarés dans .mcp.json à la racine du projet, partagé avec l'équipe (et ceux des dossiers liés).\n\nUn serveur MCP donne des outils supplémentaires à Claude : navigateur, base de données, API… « Ajouter » propose de copier un serveur déjà utilisé dans un autre de tes projets.\n\nLes serveurs perso, locaux, claude.ai et plugins sont dans le panneau de droite."))
        default: return (L("Scripts npm"),
            L("Les scripts du package.json du projet (et des workspaces ou dossiers liés).\n\nUn script se lance dans un onglet terminal réutilisé s'il est libre ; Ctrl-C l'arrête. Le badge vert indique le nombre de scripts en cours. Le gestionnaire (npm, pnpm, yarn, bun) est déduit du lockfile."))
        }
    }

    var body: some View {
        VSplitView {
            mainFinder.frame(minHeight: 160)
            if showBottom { bottomBlock }
        }
    }

    // MARK: main finder
    private var mainFinder: some View {
        VStack(spacing: 0) {
            if let r = project.root {
                HStack(spacing: 6) {
                    Image(systemName: "folder.fill").font(.system(size: 11)).foregroundStyle(Color.accentColor)
                    Text(project.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                BrowserPane(root: r).environmentObject(project).environmentObject(state)
            }
        }
    }

    // MARK: bottom block: linked folders / scripts
    private var bottomBlock: some View {
        VStack(spacing: 0) {
            Divider()
            Rectangle().fill(Color.primary.opacity(0.04)).frame(height: 5)
            Divider()
            HStack(spacing: 8) {
                let running = project.sessions.filter { $0.alive && $0.isScript && $0.busy }.count
                HStack(spacing: 2) {
                    modeButton("links", icon: "link", count: project.links.count, badge: 0, enabled: true)
                    modeButton("scripts", icon: "shippingbox", count: 0, badge: running, enabled: !project.packages.isEmpty)
                    modeButton("skills", icon: "sparkle", count: 0, badge: 0, enabled: true)
                    modeButton("mcp", icon: "point.3.connected.trianglepath.dotted", count: 0, badge: 0, enabled: true)
                }
                Spacer()
                Button { showInfo.toggle() } label: {
                    Image(systemName: "info.circle").font(.system(size: 12)).foregroundStyle(.secondary)
                        .frame(width: 22, height: 20)
                }
                .buttonStyle(.plain).help("À quoi sert ce panneau")
                .popover(isPresented: $showInfo, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(infoText.title).font(.headline)
                        Text(infoText.body).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14).frame(width: 320)
                }
                Button { project.bottomCollapsed.toggle() } label: {
                    Image(systemName: project.bottomCollapsed ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                        .frame(width: 22, height: 20)
                }
                .buttonStyle(.plain).help(project.bottomCollapsed ? L("Déplier") : L("Replier"))
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            if !project.bottomCollapsed {
                Divider()
                switch project.bottomMode {
                case "links": linksAccordion
                case "skills": ProjectSkillsPanel()
                case "mcp": ProjectMCPPanel()
                default: ScriptsPanel()
                }
            }
        }
        .frame(minHeight: project.bottomCollapsed ? 34 : 140, idealHeight: project.bottomCollapsed ? 34 : 260,
               maxHeight: project.bottomCollapsed ? 34 : .infinity)
        .onAppear {
            DispatchQueue.main.async {
                if project.bottomMode == "scripts" && project.packages.isEmpty { project.bottomMode = "links" }
            }
        }
    }

    private func modeButton(_ mode: String, icon: String, count: Int, badge: Int, enabled: Bool) -> some View {
        let selected = project.bottomMode == mode
        return Button {
            project.bottomMode = mode
            project.bottomCollapsed = false
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 12))
                if badge > 0 {
                    Text("\(badge)").font(.system(size: 10, weight: .bold)).foregroundStyle(.green)
                } else if count > 0 {
                    Text("\(count)").font(.system(size: 10, weight: .semibold))
                }
            }
            .frame(minWidth: 34, minHeight: 24)
            .padding(.horizontal, 4)
            .background(selected ? Color.accentColor.opacity(0.18) : Color.clear)
            .foregroundStyle(selected ? Color.accentColor : Color.secondary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
    }

    private var linksAccordion: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Menu {
                        ForEach(state.recent.filter { dir in dir != project.root && !project.links.contains { $0.path == dir } }, id: \.self) { dir in
                            Button((dir as NSString).lastPathComponent) { project.addLink(dir); project.saveLinks() }
                        }
                        Divider()
                        Button("Choisir un dossier…") {
                            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
                            if panel.runModal() == .OK, let u = panel.url { project.addLink(u.path); project.saveLinks() }
                        }
                    } label: {
                        Label("Lier un dossier", systemImage: "plus")
                    }
                    .menuStyle(.borderedButton).fixedSize().controlSize(.small)
                    Spacer()
                    Button { showLinks.toggle() } label: {
                        Image(systemName: "slider.horizontal.3")
                    }
                    .controlSize(.small).help("Rôles et accès")
                    .disabled(project.links.isEmpty)
                    .opacity(project.links.isEmpty ? 0.4 : 1)
                    .popover(isPresented: $showLinks, arrowEdge: .bottom) {
                        LinksEditor().environmentObject(project).environmentObject(state)
                    }
                }
                if !project.links.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(project.links) { l in
                            LinkCard(link: l, expanded: project.expandedRoot == l.path)
                            if l.path != project.links.last?.path { Divider() }
                        }
                    }
                    .modifier(BorderedBlock())
                }
                if project.links.isEmpty {
                    Text("Lie l'API, le design system… Claude y aura accès sans qu'on lui dise.")
                        .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center).padding(.top, 4)
                }
            }
            .padding(10)
        }
    }
}

/// Full-width bordered container for list content.
struct BorderedBlock: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.separator, lineWidth: 1))
    }
}

/// One linked folder as a card; expanded, it hosts its own browser pane.
struct LinkCard: View {
    let link: LinkedProject
    let expanded: Bool
    @EnvironmentObject var state: AppState
    @EnvironmentObject var project: Project

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).frame(width: 12)
                Image(systemName: "link").font(.system(size: 11)).foregroundStyle(Color.accentColor)
                Text(link.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                if !link.role.isEmpty { Text(link.role).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if link.readOnly { Image(systemName: "lock").font(.caption2).foregroundStyle(.secondary) }
                Spacer()
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .contentShape(Rectangle())
            .onTapGesture { project.expandedRoot = expanded ? nil : link.path }
            .contextMenu {
                Button("Ouvrir dans le Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: link.path)) }
                Button("Ouvrir comme projet") { state.openProject(link.path) }
                Button("Retirer le lien") { project.removeLink(link); project.saveLinks() }
            }
            if expanded {
                Divider()
                BrowserPane(root: link.path)
                    .frame(height: 260)
            }
        }
    }
}

/// File list for one root, with its own back/up navigation.
struct BrowserPane: View {
    let root: String
    @EnvironmentObject var state: AppState
    @EnvironmentObject var project: Project

    private var shown: String { project.shownFolder(for: root) }
    private var relative: String {
        shown == root ? (root as NSString).lastPathComponent : String(shown.dropFirst(root.count + 1))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button { project.navigateBack(in: root) } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless).disabled((project.navHistory[root] ?? []).isEmpty).help("Retour")
                Button { project.navigateUp(in: root) } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(.borderless).disabled(!project.canGoUp(in: root)).help("Dossier parent")
                Text(relative).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Spacer()
                Button { NSWorkspace.shared.open(URL(fileURLWithPath: shown)) } label: { Image(systemName: "arrow.up.forward.app") }
                    .buttonStyle(.borderless).help("Ouvrir dans le Finder")
            }
            .padding(.horizontal, 8).padding(.vertical, 4)

            List(selection: Binding(
                get: { project.selectedPath },
                set: {
                    guard let p = $0 else { return }
                    project.selectedPath = p
                    var d: ObjCBool = false
                    FileManager.default.fileExists(atPath: p, isDirectory: &d)
                    project.selectedFolder = d.boolValue ? p : (p as NSString).deletingLastPathComponent
                    QuickLook.shared.update(p)
                }
            )) {
                OutlineGroup(FolderNode(path: shown).children ?? [], children: \.children) { node in
                    row(node)
                }
            }
            .listStyle(.sidebar).scrollContentBackground(.hidden)
            .onKeyPress(.space) {
                QuickLook.shared.toggle(project.selectedPath)
                return .handled
            }
            .onAppear { DoubleClickMonitor.shared.install(state) }
        }
    }

    private func row(_ node: FolderNode) -> some View {
        HStack(spacing: 4) {
            Image(nsImage: node.icon)
            Text(node.name).lineLimit(1)
                .foregroundStyle(node.isDir ? .primary : .secondary)
            if node.isDir && ClaudeData.hasSessions(node.path) {
                Text("✳").font(.caption).foregroundStyle(.orange)
            }
        }
        .tag(node.path)
        .itemProvider { NSItemProvider(object: URL(fileURLWithPath: node.path) as NSURL) }
        .contextMenu {
            if node.isDir {
                Button("Claude ici") { project.newClaudeTab(cwd: node.path) }
                Button("Shell ici") { project.newShellTab(cwd: node.path) }
                Divider()
                Button("Ouvrir ce dossier") { project.navigate(to: node.path, in: root) }
                Button("Ouvrir comme projet") { state.openProject(node.path) }
            } else {
                Button("Insérer le chemin dans le prompt") { project.insertPath(node.path) }
                Button("Aperçu (Espace)") { QuickLook.shared.toggle(node.path) }
                Button("Ouvrir") { NSWorkspace.shared.open(URL(fileURLWithPath: node.path)) }
            }
            Button("Afficher dans le Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: node.path)])
            }
            Button("Copier le chemin") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.path, forType: .string)
            }
        }
    }
}

/// AppKit-level double-click detection for the outline, so List selection keeps working.
final class DoubleClickMonitor {
    static let shared = DoubleClickMonitor()
    private var monitor: Any?

    func install(_ state: AppState) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak state] event in
            guard event.clickCount == 2, let state, state.showLeft, let project = state.active, let win = event.window,
                  let content = win.contentView,
                  let hit = content.hitTest(content.convert(event.locationInWindow, from: nil)),
                  let outline = Self.enclosingOutline(hit),
                  // only the browser column (left of the terminal area)
                  outline.convert(outline.bounds, to: nil).maxX < content.bounds.width * 0.45,
                  let path = project.selectedPath else { return event }
            var d: ObjCBool = false
            FileManager.default.fileExists(atPath: path, isDirectory: &d)
            DispatchQueue.main.async {
                if d.boolValue, let r = project.owningRoot(of: path) { project.navigate(to: path, in: r) }
                else if !d.boolValue { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
            }
            return nil
        }
    }

    private static func enclosingOutline(_ v: NSView) -> NSOutlineView? {
        var cur: NSView? = v
        while let c = cur {
            if let o = c as? NSOutlineView { return o }
            cur = c.superview
        }
        return nil
    }
}
