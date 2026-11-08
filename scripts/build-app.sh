#!/bin/sh
# builds the desktop app (desktop/, wails) with the agent inside it, and leaves
# "ultimate packet inspector.app" in the repo's root. the agent stays its own
# process - the app starts it when it opens (desktop/agent.go)
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
name="ultimate packet inspector"
wails="$(command -v wails || echo "$(go env GOPATH)/bin/wails")"

cd "$root/desktop"
"$wails" build -clean -trimpath -ldflags "-s -w"
app="$root/desktop/build/bin/$name.app"
# next to the app's own binary, where desktop/agent.go looks first
go -C "$root/agent" build -trimpath -ldflags "-s -w" -o "$app/Contents/MacOS/upi" .
# the bundle changed after it was built, so it's signed again (ad hoc - it's
# only for this machine)
codesign --force --deep --sign - "$app"

rm -rf "$root/$name.app"
mv "$app" "$root/"
echo "$root/$name.app"
