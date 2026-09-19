import Foundation
import Testing

/// Temporary directory per test, removed on teardown.
final class TempDir {
    let path: String
    init() {
        path = NSTemporaryDirectory() + "claudeterm-tests-" + UUID().uuidString
        try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(atPath: path) }

    @discardableResult
    func write(_ rel: String, _ content: String) -> String {
        let p = path + "/" + rel
        try! FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try! content.write(toFile: p, atomically: true, encoding: .utf8)
        return p
    }

    func json(_ rel: String) -> [String: Any] {
        let d = FileManager.default.contents(atPath: path + "/" + rel)!
        return try! JSONSerialization.jsonObject(with: d) as! [String: Any]
    }
}

func jsonl(_ objects: [[String: Any]]) -> String {
    objects.map { String(data: try! JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }.joined(separator: "\n") + "\n"
}
