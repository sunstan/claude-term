import SwiftUI
import AppKit

/// App-level preferences window (ClaudeTerm menu › Settings…, ⌘,).
struct AppSettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var language: String = AppSettingsView.currentLanguage()
    @State private var needsRelaunch = false
    @AppStorage("appearance") private var appearance = "system"
    @State private var hooksOn = EventHub.hooksInstalled()
    @State private var notifyMac = EventHub.notificationsEnabled
    @State private var dockBadge = EventHub.dockBadgeEnabled
    @State private var hookError: String?

    static func currentLanguage() -> String {
        (UserDefaults.standard.stringArray(forKey: "AppleLanguages")?.first).map { String($0.prefix(2)) } ?? "system"
    }

    var body: some View {
        Form {
            Section("Général") {
                Picker("Langue", selection: $language) {
                    Text("Système").tag("system")
                    Text("Français").tag("fr")
                    Text("English").tag("en")
                }
                .onChange(of: language) { _, v in
                    if v == "system" { UserDefaults.standard.removeObject(forKey: "AppleLanguages") }
                    else { UserDefaults.standard.set([v], forKey: "AppleLanguages") }
                    needsRelaunch = true
                }
                Text("La langue de l'interface. Le changement prend effet au prochain lancement.")
                    .font(.caption).foregroundStyle(.secondary)
                if needsRelaunch {
                    HStack {
                        Text("Relancer pour appliquer").font(.caption).foregroundStyle(.orange)
                        Spacer()
                        Button("Relancer ClaudeTerm") { Self.relaunch() }
                    }
                }
            }
            Section("Apparence") {
                Picker("Thème", selection: $appearance) {
                    Text("Système").tag("system")
                    Text("Clair").tag("light")
                    Text("Sombre").tag("dark")
                }
                .onChange(of: appearance) { _, v in Self.applyAppearance(v) }
                Text("Le terminal suit le thème : palette One Light en clair, One Dark en sombre.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Notifications") {
                Toggle("Installer les hooks Claude Code", isOn: $hooksOn)
                    .onChange(of: hooksOn) { _, on in
                        do { try EventHub.setHooksInstalled(on); hookError = nil }
                        catch { hookError = error.localizedDescription; hooksOn = !on }
                    }
                Text("Ajoute deux hooks (Notification, Stop) dans ~/.claude/settings.json qui signalent à ClaudeTerm les permissions en attente, les sessions inactives et les réponses terminées. Fonctionne aussi pour les sessions lancées hors de ClaudeTerm dans un dossier ouvert.")
                    .font(.caption).foregroundStyle(.secondary)
                if let e = hookError { Text(e).font(.caption).foregroundStyle(.red) }
                Toggle("Notifications macOS quand l'onglet n'est pas visible", isOn: $notifyMac)
                    .onChange(of: notifyMac) { _, v in EventHub.notificationsEnabled = v }
                Toggle("Badge sur l'icône du Dock", isOn: $dockBadge)
                    .onChange(of: dockBadge) { _, v in EventHub.dockBadgeEnabled = v; state.refreshDockBadge() }
            }
            Section("Terminal") {
                Picker("Police du terminal", selection: $state.fontName) {
                    ForEach(state.monoFonts, id: \.self) { Text($0.isEmpty ? L("par défaut") : $0).tag($0) }
                }
                Stepper("Taille : \(Int(state.fontSize)) pt", value: $state.fontSize, in: 9...24)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding(.bottom, 8)
    }

    static func applyAppearance(_ v: String = UserDefaults.standard.string(forKey: "appearance") ?? "system") {
        switch v {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    static func relaunch() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "sleep 0.6; /usr/bin/open -n \(shellQuote(path))"]
        try? task.run()
        NSApp.terminate(nil)
    }
}
