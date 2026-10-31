#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/dist/bundle"
APP_DIR="$BUNDLE_DIR/OpenSand.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_PAYLOAD_DIR="$RESOURCES_DIR/app"

echo "===> Building OpenSand macOS Application Bundle..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$APP_PAYLOAD_DIR"

# 1. Generate Info.plist
cat << 'EOF' > "$CONTENTS_DIR/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>OpenSand</string>
    <key>CFBundleIdentifier</key>
    <string>com.opensand.agent</string>
    <key>CFBundleName</key>
    <string>OpenSand</string>
    <key>CFBundleDisplayName</key>
    <string>OpenSand</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <false/>
    <key>NSScreenCaptureUsageDescription</key>
    <string>OpenSand requires screen capture access to analyze visible code windows and recognize screen text.</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

# 2. Copy Native Mach-O Executables
if [ -f "$ROOT_DIR/packages/native-bridge/bin/sand-vision" ]; then
  cp "$ROOT_DIR/packages/native-bridge/bin/sand-vision" "$MACOS_DIR/"
  chmod +x "$MACOS_DIR/sand-vision"
fi

if [ -f "$ROOT_DIR/packages/native-bridge/bin/sand-window-capture" ]; then
  cp "$ROOT_DIR/packages/native-bridge/bin/sand-window-capture" "$MACOS_DIR/"
  chmod +x "$MACOS_DIR/sand-window-capture"
fi

# 3. Copy Application Assets & Compiled Packages
mkdir -p "$APP_PAYLOAD_DIR/packages"
cp -R "$ROOT_DIR/packages/desktop" "$APP_PAYLOAD_DIR/packages/"
cp -R "$ROOT_DIR/packages/coordinator" "$APP_PAYLOAD_DIR/packages/"
cp -R "$ROOT_DIR/packages/local-exec-daemon" "$APP_PAYLOAD_DIR/packages/"
cp -R "$ROOT_DIR/packages/native-bridge" "$APP_PAYLOAD_DIR/packages/"
cp "$ROOT_DIR/package.json" "$APP_PAYLOAD_DIR/"

# 4. Generate Launcher Script
cat << 'EOF' > "$MACOS_DIR/OpenSand"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$DIR/../Resources/app"

export OPENSAND_BIN_DIR="$DIR"
export PATH="$DIR:$PATH"

# Prefer electron if installed globally or locally
if command -v electron >/dev/null 2>&1; then
  exec electron "$APP_ROOT/packages/desktop"
elif [ -f "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot" ]; then
  # Alternative: fallback to local node runner
  NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
  exec "$NODE_BIN" "$APP_ROOT/packages/desktop/dist/src/desktop-server.js"
else
  NODE_BIN="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
  echo "Launching OpenSand Desktop Server on port 3456..."
  "$NODE_BIN" "$APP_ROOT/packages/desktop/dist/src/desktop-server.js" &
  SERVER_PID=$!
  sleep 1
  open "http://127.0.0.1:3456"
  wait $SERVER_PID
fi
EOF

chmod +x "$MACOS_DIR/OpenSand"

echo "===> macOS Application Bundle Created Successfully: $APP_DIR"
ls -la "$MACOS_DIR"
