import SwiftUI
import AppKit
import class SwiftTerm.TerminalView

struct TerminalArea: View {
    @EnvironmentObject var project: Project

    var body: some View {
        VSplitView {
            VStack(spacing: 0) {
                TabBar()
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                Group {
                    if let s = project.current {
                        TerminalHost(session: s)
                    } else {
                        EmptyTerminal()
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator, lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                .padding(.horizontal, 12)
                StatusBar()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
            }
            .frame(minHeight: 200)
            SessionBlock()
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// Bottom block of the center area: Plan / Activity / Files of the active Claude tab.
struct SessionBlock: View {
    @EnvironmentObject var project: Project
    @State private var showInfo = false
    @State private var lastAutoOpenedPlan: String?

    private var session: TerminalSession? { project.current.flatMap { $0.isClaude ? $0 : nil } }
    private var collapsed: Bool { project.sessionCollapsed }

    private var infoText: (String, String) {
        switch project.sessionMode {
        case "activity": return (L("Activité"), L("Le flux de la session Claude en cours, lu dans son transcript : tes messages, ses réponses, chaque outil appelé (fichier, commande, recherche) et le compteur de tokens.\n\nClic droit sur une ligne : ouvrir le fichier, copier."))
        case "files": return (L("Fichiers"), L("Les fichiers que Claude a lus ou modifiés pendant cette session, avec le nombre d'accès.\n\nDouble-clic pour ouvrir, clic droit pour le Finder ou copier le chemin."))
        default: return (L("Plan"), L("Le plan que Claude rédige quand il passe en mode plan (fichier dans ~/.claude/plans). Il s'affiche en direct, avec la progression si le plan contient des cases à cocher.\n\nLe volet s'ouvre tout seul à l'entrée en mode plan. Le menu permet de lier un autre plan ou de le détacher."))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            Rectangle().fill(Color.primary.opacity(0.04)).frame(height: 5)
            Divider()
            HStack(spacing: 8) {
                HStack(spacing: 2) {
                    modeButton("plan", icon: "list.clipboard", active: session?.planMode ?? false)
                    modeButton("activity", icon: "waveform.path.ecg", active: !(session?.runningTools.isEmpty ?? true))
                    modeButton("files", icon: "doc.text", active: false, count: session?.files.count ?? 0)
                }
                if let s = session { SessionTitle(session: s) }
                Spacer()
                Button { showInfo.toggle() } label: {
                    Image(systemName: "info.circle").font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 22, height: 20)
                }
                .buttonStyle(.plain).help("À quoi sert ce panneau")
                .popover(isPresented: $showInfo, arrowEdge: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(infoText.0).font(.headline)
                        Text(infoText.1).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14).frame(width: 320)
                }
                Button { project.sessionCollapsed.toggle() } label: {
                    Image(systemName: collapsed ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary).frame(width: 22, height: 20)
                }
                .buttonStyle(.plain).help(collapsed ? L("Déplier") : L("Replier"))
                .keyboardShortcut("3", modifiers: [.command, .option])
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            if !collapsed {
                Divider()
                if let s = session {
                    switch project.sessionMode {
                    case "activity": ActivityTab(session: s)
                    case "files": FilesTab(session: s)
                    default: PlanTab(session: s)
                    }
                } else {
                    EmptyHint("Sélectionne un onglet Claude, ou tape claude dans un shell")
                }
            }
        }
        .frame(minHeight: collapsed ? 30 : 140, idealHeight: collapsed ? 30 : 260, maxHeight: collapsed ? 30 : .infinity)
        .onChange(of: session?.planMode ?? false) { _, on in
            // auto-open on plan mode, once per plan file (deferred: this view lives in a split view)
            guard on, let p = session?.planPath ?? session.map({ _ in "pending" }), p != lastAutoOpenedPlan else { return }
            lastAutoOpenedPlan = p
            DispatchQueue.main.async {
                project.sessionMode = "plan"
                project.sessionCollapsed = false
            }
        }
    }

    private func modeButton(_ mode: String, icon: String, active: Bool, count: Int = 0) -> some View {
        let selected = project.sessionMode == mode
        return Button {
            project.sessionMode = mode
            project.sessionCollapsed = false
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 12))
                if active { Circle().fill(Color.orange).frame(width: 6, height: 6) }
                else if count > 0 { Text("\(count)").font(.system(size: 10, weight: .semibold)) }
            }
            .frame(minWidth: 34, minHeight: 24)
            .padding(.horizontal, 4)
            .background(selected ? Color.accentColor.opacity(0.18) : Color.clear)
            .foregroundStyle(selected ? Color.accentColor : Color.secondary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

private struct SessionTitle: View {
    @ObservedObject var session: TerminalSession
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles").font(.system(size: 10)).foregroundStyle(.orange)
            Text(session.title).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

struct EmptyTerminal: View {
    @EnvironmentObject var project: Project
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles").font(.system(size: 34)).foregroundStyle(.orange)
            Text("Aucune session").font(.title3.weight(.semibold))
            Text(project.selectedFolder.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button { project.newClaudeTab() } label: { Label("Démarrer Claude", systemImage: "sparkles") }
                    .buttonStyle(.borderedProminent)
                Button { project.newShellTab() } label: { Label("Shell", systemImage: "terminal") }
            }
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }
}

struct TabBar: View {
    @EnvironmentObject var project: Project

    var body: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(project.sessions) { s in
                        TabItem(session: s, selected: s.id == project.currentId)
                            .onTapGesture { project.currentId = s.id }
                    }
                }
            }
            Button { project.newShellTab() } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless)
                .help("Nouvel onglet (⌘T)")
            Spacer(minLength: 0)
            Button {
                if let s = project.current { Attachments.captureScreen(into: s.view) }
            } label: { Label("Capture", systemImage: "camera.viewfinder") }
                .buttonStyle(.borderless)
                .help("Capture d'écran → prompt (⌥⌘S)")
                .keyboardShortcut("s", modifiers: [.command, .option])
                .disabled(project.current == nil)
        }
    }
}

struct TabItem: View {
    @ObservedObject var session: TerminalSession
    @EnvironmentObject var project: Project
    let selected: Bool
    @State private var hover = false

    private var iconColor: Color {
        guard session.alive else { return .secondary }
        if session.isClaude { return .orange }
        if session.busy { return .green }
        if session.isScript, let e = session.lastExit, e != 0 { return .red }
        return .accentColor
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: session.isClaude ? "sparkles" : (session.isScript ? "shippingbox" : "terminal"))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(iconColor)
                .overlay(alignment: .topTrailing) {
                    if let a = session.attention {
                        Circle().fill(a.color).frame(width: 7, height: 7)
                            .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
                            .offset(x: 4, y: -4)
                    }
                }
            Text(session.title).lineLimit(1).font(.system(size: 12, weight: selected ? .semibold : .regular))
                .frame(maxWidth: 180)
            Button { project.close(session) } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .opacity(hover || selected ? 1 : 0)
        }
        .padding(.leading, 10).padding(.trailing, 6).padding(.vertical, 5)
        .background(selected ? Color.accentColor.opacity(0.18) : (hover ? Color.primary.opacity(0.06) : Color.clear))
        .clipShape(Capsule())
        .contentShape(Capsule())
        .onHover { hover = $0 }
        .help(session.attention?.label ?? "")
    }
}

struct StatusBar: View {
    @EnvironmentObject var project: Project

    var body: some View {
        HStack(spacing: 10) {
            if let s = project.current {
                StatusItem(session: s)
            } else {
                Text(" ").font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct StatusItem: View {
    @ObservedObject var session: TerminalSession
    var body: some View {
        Label(session.cwd.replacingOccurrences(of: NSHomeDirectory(), with: "~"), systemImage: "folder")
            .lineLimit(1).truncationMode(.middle)
        if session.isClaude {
            if let a = session.attention { Badge(text: a.label, color: a.color) }
            if let pm = session.permissionMode {
                Badge(text: pm, color: pm == "plan" ? .orange : .accentColor)
            }
            if session.planMode { Badge(text: L("plan"), color: .orange) }
            Spacer()
            Label("\(session.inputTokens.formatted()) ↓", systemImage: "arrow.down.circle")
            Label("\(session.outputTokens.formatted()) ↑", systemImage: "arrow.up.circle")
        } else {
            if session.busy {
                ProgressView().controlSize(.mini)
                Text(session.lastCommand).lineLimit(1).truncationMode(.tail).foregroundStyle(.secondary)
            } else if let e = session.lastExit {
                Badge(text: e == 0 ? "ok" : "exit \(e)", color: e == 0 ? .green : .red)
                Text(session.lastCommand).lineLimit(1).truncationMode(.tail).foregroundStyle(.tertiary)
            }
            Spacer()
        }
        Circle().fill(session.alive ? Color.green : Color.red).frame(width: 7, height: 7)
    }
}

struct Badge: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.18)).foregroundStyle(color)
            .clipShape(Capsule())
    }
}

/// Container that swaps the session's terminal view in and re-applies colors on appearance change.
final class TerminalContainer: NSView {
    var onAppearanceChange: (() -> Void)?
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }
}

struct TerminalHost: NSViewRepresentable {
    let session: TerminalSession

    func makeNSView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        attach(session.view, to: container)
        return container
    }

    func updateNSView(_ container: TerminalContainer, context: Context) {
        guard container.subviews.first !== session.view else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        attach(session.view, to: container)
        DispatchQueue.main.async { session.app?.clearAttention(session) }
    }

    /// Only on tab switch / first display: apply theme and take focus.
    private func attach(_ v: TerminalView, to container: TerminalContainer) {
        v.frame = container.bounds
        v.autoresizingMask = [.width, .height]
        container.addSubview(v)
        container.onAppearanceChange = { [weak v] in v.map(Theme.apply) }
        DispatchQueue.main.async {
            Theme.apply(to: v)
            container.window?.makeFirstResponder(v)
        }
    }
}
