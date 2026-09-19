import Foundation
import SwiftUI

/// Localizes a plain (non-interpolated) string at runtime. For interpolated text use `String(localized:)` directly.
func L(_ key: String) -> String {
    String(localized: String.LocalizationValue(key))
}

extension Text {
    /// Text from a runtime string that is itself a localization key (enum raw values…).
    init(key: String) { self.init(LocalizedStringKey(key)) }
}
