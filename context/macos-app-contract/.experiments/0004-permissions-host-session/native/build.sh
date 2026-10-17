#!/bin/bash
# Source-only preparation entrypoint. Compilation does not launch any probe/API.
# Usage: bash native/build.sh OUT [1|2]
# Requires Xcode command-line tools + macOS 14.4 SDK, arm64 macOS builder.
# Outputs: OUT/MacPermissionsHostExperiment.app, OUT/client,
# OUT/PermissionsFixture.app. Integration adds source-hash, helper provenance,
# nested restic/watchman, and seals the whole bundle after helper signing.
set -euo pipefail
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
out="${1:?output directory required}"
release="${2:-1}"
case "$release" in
  1) defines=(-D RELEASE_V1) ;;
  2) defines=(-D RELEASE_V2) ;;
  *) printf 'release must be 1 or 2\n' >&2; exit 64 ;;
esac
host_app="$out/MacPermissionsHostExperiment.app"
mkdir -p "$out/PermissionsFixture.app/Contents/MacOS" "$host_app/Contents/MacOS" "$host_app/Contents/Resources"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -swift-version 5 -O -parse-as-library -sdk "$sdk" -target arm64-apple-macosx14.4 "${defines[@]}" \
  -framework AppKit -framework ApplicationServices -framework AVFoundation -framework ScreenCaptureKit \
  -framework UserNotifications -framework CryptoKit -framework AudioToolbox -framework Security \
  "$source_dir/Host.swift" -o "$host_app/Contents/MacOS/permissions-host"
xcrun swiftc -swift-version 5 -O -sdk "$sdk" -target arm64-apple-macosx14.4 \
  "$source_dir/Client.swift" -o "$out/client"
xcrun swiftc -swift-version 5 -O -sdk "$sdk" -target arm64-apple-macosx14.4 -framework AppKit \
  "$source_dir/Fixture.swift" -o "$out/PermissionsFixture.app/Contents/MacOS/fixture"
cat > "$out/PermissionsFixture.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.overeng.permissions-host.fixture</string>
<key>CFBundleName</key><string>Permissions Fixture</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.4</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cat > "$host_app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.overeng.permissions-host.experiment</string>
<key>CFBundleName</key><string>Mac Permissions Host (Experiment)</string>
<key>CFBundleDisplayName</key><string>Mac Permissions Host (Experiment)</string>
<key>CFBundleExecutable</key><string>permissions-host</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>$release</string>
<key>CFBundleShortVersionString</key><string>1.$release</string>
<key>LSMinimumSystemVersion</key><string>14.4</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Explicit live-session microphone permission experiment.</string>
<key>NSAudioCaptureUsageDescription</key><string>Capture the experiment's synthetic system-audio test tone.</string>
<key>NSAppleEventsUsageDescription</key><string>Explicit live-session Automation permission experiment for two fixed applications.</string>
</dict></plist>
PLIST
