import SwiftUI
import AppKit

@main
struct ClaudeTermApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup("ClaudeTerm") {
            MainView()
                .environmentObject(state)
                .frame(minWidth: 1100, minHeight: 650)
        }
        .windowToolbarStyle(.unified)
        .defaultSize(width: 1400, height: 850)
        Settings {
            AppSettingsView().environmentObject(state)
        }
        .commands {
            CommandGroup(after: .sidebar) {
                Button("Afficher/masquer le Finder") { state.showLeft.toggle() }
                    .keyboardShortcut("1", modifiers: [.command, .option])
                Button("Afficher/masquer les outils") { state.showRight.toggle() }
                    .keyboardShortcut("2", modifiers: [.command, .option])
            }
            CommandGroup(after: .newItem) {
                Button("Nouveau projet") { state.newBlankProject() }
                    .keyboardShortcut("n")
                Button("Ouvrir un dossier…") { state.chooseFolder(for: state.active) }
                    .keyboardShortcut("o")
                Button("Fermer le projet") { if let p = state.active { state.closeProject(p) } }
                    .keyboardShortcut("w", modifiers: [.command, .shift])
                Divider()
                Button("Nouvel onglet") { state.active?.newShellTab() }
                    .keyboardShortcut("t")
                Button("Nouvel onglet Claude") { state.active?.newClaudeTab() }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
                Button("Fermer l'onglet") { state.active?.closeCurrentTab() }
                    .keyboardShortcut("w")
                Divider()
                Button("Onglet suivant") { state.active?.cycleTab(1) }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Onglet précédent") { state.active?.cycleTab(-1) }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Button("Projet suivant") { state.cycleProject(1) }
                    .keyboardShortcut("]", modifiers: [.command, .option])
                Button("Projet précédent") { state.cycleProject(-1) }
                    .keyboardShortcut("[", modifiers: [.command, .option])
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppSettingsView.applyAppearance()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        EventHub.shared.state?.currentTabShown()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct MainView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if let p = state.active {
                ProjectView(project: p)
                    .id(p.id)
            }
        }
        .onAppear { EventHub.shared.start(state: state) }
        .onChange(of: state.activeId) { _, _ in state.currentTabShown() }
        .navigationTitle("")
        .sheet(item: $state.editingSkill) { s in SkillEditorSheet(skill: s).environmentObject(state) }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button { state.showLeft.toggle() } label: {
                    Image(systemName: state.showLeft ? "sidebar.left" : "sidebar.leading")
                }
                .help("Finder (⌥⌘1)")
            }
            ToolbarItem(placement: .principal) {
                ProjectBar()
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { state.showRight.toggle() } label: {
                    Image(systemName: state.showRight ? "sidebar.right" : "sidebar.trailing")
                }
                .help("Outils Claude (⌥⌘2)")
            }
        }
    }
}

/// Top row: one tab per open project.
struct ProjectBar: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 6) {
            ForEach(state.projects) { p in
                ProjectTab(project: p, selected: p.id == state.activeId)
                    .onTapGesture { state.activeId = p.id }
            }
            Button { state.newBlankProject() } label: {
                Image(systemName: "plus").font(.system(size: 11, weight: .semibold))
                    .frame(width: 26, height: 26)
                    .background(Color.primary.opacity(0.08))
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Nouveau projet (⌘N)")
        }
        .padding(.horizontal, 3)
    }
}

struct ProjectTab: View {
    @ObservedObject var project: Project
    @EnvironmentObject var state: AppState
    let selected: Bool
    @State private var hover = false

    private var busyCount: Int { project.sessions.filter { $0.alive && ($0.busy || $0.isClaude) }.count }
    private var attentionCount: Int { project.sessions.filter { $0.attention != nil }.count }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: project.root == nil ? "folder.badge.plus" : "folder.fill")
                .font(.system(size: 11)).foregroundStyle(selected ? Color.accentColor : Color.secondary)
            Text(project.name).font(.system(size: 12, weight: selected ? .semibold : .regular)).lineLimit(1)
            if attentionCount > 0 {
                Text("\(attentionCount)").font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.orange.opacity(0.25)).foregroundStyle(.orange).clipShape(Capsule())
            } else if busyCount > 0 {
                Text("\(busyCount)").font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.green.opacity(0.2)).foregroundStyle(.green).clipShape(Capsule())
            }
            Button { state.closeProject(project) } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 11))
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .opacity(hover || selected ? 1 : 0)
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.vertical, 6)
        .background(selected ? Color.accentColor.opacity(0.15) : (hover ? Color.primary.opacity(0.05) : Color.clear))
        .clipShape(Capsule())
        .contentShape(Capsule())
        .onHover { hover = $0 }
        .contextMenu {
            if let r = project.root {
                Button("Afficher dans le Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: r)) }
            }
            Button("Fermer le projet") { state.closeProject(project) }
        }
    }
}

/// Everything below the project bar for one project.
struct ProjectView: View {
    @ObservedObject var project: Project
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if project.root == nil {
                WelcomeView(project: project)
            } else {
                HSplitView {
                    if state.showLeft {
                        FileBrowserView()
                            .frame(minWidth: 200, idealWidth: 250, maxWidth: 420)
                            .background(Color(nsColor: .windowBackgroundColor))
                    }
                    TerminalArea()
                        .frame(minWidth: 500)
                    if state.showRight {
                        ToolsPanel()
                            .frame(minWidth: 280, idealWidth: 340, maxWidth: 560)
                            .background(Color(nsColor: .windowBackgroundColor))
                    }
                }
            }
        }
        .environmentObject(project)
    }
}

struct WelcomeView: View {
    @ObservedObject var project: Project
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 16) {
                Image(systemName: "sparkles").font(.system(size: 40)).foregroundStyle(.orange)
                Text("ClaudeTerm").font(.title.weight(.semibold))
                Text("Ouvre un dossier pour démarrer un projet.").foregroundStyle(.secondary)
                Button { state.chooseFolder(for: project) } label: {
                    Label("Ouvrir un dossier…", systemImage: "folder").frame(minWidth: 180)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut("o")
                HStack(spacing: 8) {
                    ForEach(["Documents/development", "Documents", ""], id: \.self) { rel in
                        let dir = rel.isEmpty ? NSHomeDirectory() : NSHomeDirectory() + "/" + rel
                        Button(rel.isEmpty ? "Home" : (rel as NSString).lastPathComponent) { project.setRoot(dir); state.activeId = project.id }
                            .controlSize(.small)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !state.recent.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    Text("Récents").font(.headline).padding(.horizontal, 16).padding(.vertical, 12)
                    List(state.recent.filter { FileManager.default.fileExists(atPath: $0) }, id: \.self) { dir in
                        HStack(spacing: 8) {
                            Image(nsImage: {
                                let i = NSWorkspace.shared.icon(forFile: dir); i.size = NSSize(width: 20, height: 20); return i
                            }())
                            VStack(alignment: .leading, spacing: 1) {
                                Text((dir as NSString).lastPathComponent).font(.system(size: 12, weight: .medium))
                                Text(dir.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                            }
                            Spacer()
                            if ClaudeData.hasSessions(dir) { Text("✳").foregroundStyle(.orange) }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { project.setRoot(dir); state.activeId = project.id }
                    }
                    .listStyle(.inset).scrollContentBackground(.hidden)
                }
                .frame(width: 320)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
