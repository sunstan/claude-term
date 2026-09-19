import AppKit
import SwiftTerm
import UniformTypeIdentifiers

/// Turns dropped/pasted/captured images into files, and types their path into the terminal.
enum Attachments {
    static let dir: String = {
        let d = NSHomeDirectory() + "/Library/Application Support/ClaudeTerm/drops"
        try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        return d
    }()

    static func newPath(ext: String = "png") -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return dir + "/\(f.string(from: Date())).\(ext)"
    }

    /// Escapes a path the way a terminal drag-and-drop does (backslash before spaces).
    static func escape(_ p: String) -> String {
        p.replacingOccurrences(of: #"([ '"()\[\]&;$])"#, with: #"\\$1"#, options: .regularExpression)
    }

    static func send(paths: [String], to view: TerminalView) {
        guard !paths.isEmpty else { return }
        view.send(txt: paths.map(escape).joined(separator: " ") + " ")
    }

    static func savePNG(_ image: NSImage) -> String? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let p = newPath()
        return (try? png.write(to: URL(fileURLWithPath: p))) != nil ? p : nil
    }

    /// Extracts file paths from a pasteboard, saving raw image data to disk if needed.
    static func paths(from pb: NSPasteboard) -> [String] {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return urls.map(\.path)
        }
        if let img = NSImage(pasteboard: pb), let p = savePNG(img) { return [p] }
        if let urls = pb.readObjects(forClasses: [NSURL.self]) as? [URL],
           let u = urls.first, let data = try? Data(contentsOf: u), let img = NSImage(data: data), let p = savePNG(img) {
            return [p]
        }
        return []
    }

    /// Interactive screen capture, then types the file path.
    static func captureScreen(into view: TerminalView) {
        let p = newPath()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-i", "-r", p]
        task.terminationHandler = { _ in
            DispatchQueue.main.async {
                if FileManager.default.fileExists(atPath: p) {
                    send(paths: [p], to: view)
                    NSApp.activate(ignoringOtherApps: true)
                    view.window?.makeFirstResponder(view)
                }
            }
        }
        try? task.run()
    }
}

/// Terminal view with image paste support and drop handling.
final class ClaudeTerminalView: LocalProcessTerminalView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL, .png, .tiff, .URL])
    }
    required init?(coder: NSCoder) { fatalError() }

    override func paste(_ sender: Any?) {
        let pb = NSPasteboard.general
        if pb.string(forType: .string) == nil, let img = NSImage(pasteboard: pb), let p = Attachments.savePNG(img) {
            Attachments.send(paths: [p], to: self)
            return
        }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let paths = Attachments.paths(from: sender.draggingPasteboard)
        guard !paths.isEmpty else { return false }
        Attachments.send(paths: paths, to: self)
        window?.makeFirstResponder(self)
        return true
    }
}
