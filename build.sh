#!/bin/zsh
# Build ClaudeTerm.app from the SwiftPM executable.
set -e
cd "$(dirname "$0")"
swift build -c release 2>&1 | tail -5
APP=ClaudeTerm.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/ClaudeTerm "$APP/Contents/MacOS/"
cp -R Resources/*.lproj "$APP/Contents/Resources/"
cp Resources/AppIcon.icns "$APP/Contents/Resources/"
BUILD=$(date +%Y%m%d%H%M%S)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ClaudeTerm</string>
  <key>CFBundleDisplayName</key><string>ClaudeTerm</string>
  <key>CFBundleIdentifier</key><string>fr.jerome.claudeterm</string>
  <key>CFBundleExecutable</key><string>ClaudeTerm</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>CFBundleLocalizations</key><array><string>fr</string><string>en</string></array>
</dict></plist>
PLIST
codesign --force --sign - "$APP" 2>/dev/null || true
echo "→ $APP prêt. Lancer: open $APP"
