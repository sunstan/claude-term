import AppKit
import SwiftTerm

/// Terminal colors that follow the system appearance.
enum Theme {
    static func isDark(_ view: NSView) -> Bool {
        view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    static func apply(to t: TerminalView) {
        let dark = isDark(t)
        t.nativeBackgroundColor = dark
            ? NSColor(srgbRed: 0.11, green: 0.11, blue: 0.13, alpha: 1)
            : NSColor(srgbRed: 0.985, green: 0.985, blue: 0.99, alpha: 1)
        t.nativeForegroundColor = dark
            ? NSColor(srgbRed: 0.88, green: 0.88, blue: 0.90, alpha: 1)
            : NSColor(srgbRed: 0.17, green: 0.17, blue: 0.20, alpha: 1)
        t.caretColor = dark ? NSColor(srgbRed: 1, green: 0.6, blue: 0.2, alpha: 1) : NSColor(srgbRed: 0.9, green: 0.45, blue: 0.1, alpha: 1)
        t.selectedTextBackgroundColor = NSColor.selectedTextBackgroundColor
        t.installColors(dark ? darkANSI : lightANSI)
    }

    private static func c(_ hex: UInt32) -> SwiftTerm.Color {
        SwiftTerm.Color(red: UInt16((hex >> 16) & 0xff) * 257, green: UInt16((hex >> 8) & 0xff) * 257, blue: UInt16(hex & 0xff) * 257)
    }

    // Soft palettes (inspired by One Dark / One Light).
    static let darkANSI: [SwiftTerm.Color] = [
        c(0x3b3f4a), c(0xe06c75), c(0x98c379), c(0xe5c07b), c(0x61afef), c(0xc678dd), c(0x56b6c2), c(0xd7dae0),
        c(0x5c6370), c(0xef7c86), c(0xa9d68a), c(0xf0cb8a), c(0x74bbf5), c(0xd48ce6), c(0x6cc5d0), c(0xffffff),
    ]
    static let lightANSI: [SwiftTerm.Color] = [
        c(0x383a42), c(0xe45649), c(0x50a14f), c(0xc18401), c(0x4078f2), c(0xa626a4), c(0x0184bc), c(0xa0a1a7),
        c(0x4f525e), c(0xe06b5f), c(0x62b25f), c(0xd09a24), c(0x5b8ff5), c(0xb544b3), c(0x2296c9), c(0x383a42),
    ]
}
