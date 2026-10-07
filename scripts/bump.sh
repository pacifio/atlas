#!/usr/bin/env bash
# Bump Atlas's version in every file that has to stay in sync.
#
# Usage:
#   ./scripts/bump.sh             # bumps the patch number: 0.1.2 -> 0.1.3
#   ./scripts/bump.sh 0.2.0       # sets the version explicitly (must be X.Y.Z)
#
# Touches:
#   - package.json                  ("version": "...")
#   - src-tauri/Cargo.toml          (version = "...")
#   - Cargo.lock                    (the atlas package's entry)
#   - src-tauri/tauri.conf.json     ("version": "...")
#   - src/features/settings/components/settings-panel.tsx  (About label)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/package.json"
CARGO="$ROOT/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"
SETTINGS="$ROOT/src/features/settings/components/settings-panel.tsx"

# Source of truth = package.json. Pull the first `"version": "..."` line.
current=$(grep -m1 '"version":' "$PKG" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')
if [ -z "$current" ]; then
  echo "error: could not read current version from $PKG" >&2
  exit 1
fi

if [ "$#" -ge 1 ]; then
  new="$1"
  if ! echo "$new" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "error: '$new' is not a valid X.Y.Z version" >&2
    exit 1
  fi
else
  IFS='.' read -r major minor patch <<< "$current"
  if [ -z "${patch:-}" ] || ! echo "${major}${minor}${patch}" | grep -Eq '^[0-9]+$'; then
    echo "error: current version '$current' is not X.Y.Z" >&2
    exit 1
  fi
  new="$major.$minor.$((patch + 1))"
fi

if [ "$current" = "$new" ]; then
  echo "version is already $new — nothing to do"
  exit 0
fi

echo "bumping $current -> $new"

# Escape the dots in the current version so they're treated as literal in
# sed (the only special character that appears in a semver string).
escaped=$(printf '%s' "$current" | sed 's/\./\\./g')

# BSD/macOS sed wants `-i ''`. Atlas is mac-targeted so we lean into that.
in_place() {
  sed -i '' "$@"
}

# JSON files: the only `"version": "X.Y.Z"` literal in either file is the
# top-level one (no deps in tauri.conf.json; package.json's other version
# fields like `"packageManager"` aren't quoted this way).
in_place "s/\"version\": \"$escaped\"/\"version\": \"$new\"/g" "$PKG"
in_place "s/\"version\": \"$escaped\"/\"version\": \"$new\"/g" "$TAURI_CONF"

# Cargo.toml: anchor with `^` so we don't replace a dep's pinned version
# elsewhere in the file.
in_place "s/^version = \"$escaped\"/version = \"$new\"/" "$CARGO"

# Settings panel About label.
in_place "s/v$escaped — The second brain IDE/v$new — The second brain IDE/g" "$SETTINGS"

# Cargo.lock records the app's own version too. Left stale, every CI job's
# `cargo test --locked` refuses to run (one "v bump" commit failed 63 jobs).
# `--workspace` touches only workspace members' entries; `--offline` because
# no dependency changes.
(cd "$ROOT" && cargo update --workspace --offline --quiet)

echo "done. updated:"
echo "  $PKG"
echo "  $CARGO"
echo "  $ROOT/Cargo.lock"
echo "  $TAURI_CONF"
echo "  $SETTINGS"
