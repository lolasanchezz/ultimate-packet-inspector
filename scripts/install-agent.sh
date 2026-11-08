#!/bin/sh
# builds upi and puts it on the PATH, so it runs from anywhere without the repo
# around
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-$HOME/.local/bin}"

mkdir -p "$dest"
# built next to where it's going, then moved over the old one - copying onto a
# running binary breaks its signature and macOS kills it
tmp="$dest/.upi.$$"
trap 'rm -f "$tmp"' EXIT
cd "$root/agent"
go build -trimpath -ldflags "-s -w" -o "$tmp" .
mv -f "$tmp" "$dest/upi"
echo "$dest/upi"

case ":$PATH:" in
*":$dest:"*) ;;
*) echo "$dest isn't on your PATH - add it to your shell profile" ;;
esac
