#!/usr/bin/env bash
# Copy the pure simulation engine into the phone app's web tree.
# The Capacitor webDir is app/ alone, so engine/ and the prompt builder must be
# vendored under app/vendor/ for the WebView to import them. Run from repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rm -rf "$ROOT/app/vendor"
mkdir -p "$ROOT/app/vendor/server"
cp -r "$ROOT/engine" "$ROOT/app/vendor/engine"
cp "$ROOT/server/prompt.js" "$ROOT/app/vendor/server/prompt.js"
echo "vendored engine/ + server/prompt.js into app/vendor/"
