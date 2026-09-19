import AppKit
import Quartz

/// Drives the system Quick Look panel for one file path.
final class QuickLook: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = QuickLook()
    private var path: String?

    func toggle(_ p: String?) {
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible && (p == nil || p == path) {
            panel.orderOut(nil)
            return
        }
        path = p
        panel.dataSource = self
        panel.delegate = self
        if panel.isVisible { panel.reloadData() } else { panel.makeKeyAndOrderFront(nil) }
    }

    /// Follows the selection while the panel is open.
    func update(_ p: String?) {
        guard let panel = QLPreviewPanel.shared(), panel.isVisible, p != path else { return }
        path = p
        panel.reloadData()
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { path == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        URL(fileURLWithPath: path!) as NSURL
    }
    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        // Space closes, like the Finder.
        if event.type == .keyDown && event.keyCode == 49 { panel.orderOut(nil); return true }
        return false
    }
}
