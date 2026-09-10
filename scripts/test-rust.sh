#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# apple-sys needs the active macOS SDK while compiling native dependencies.
# Respect an explicitly selected SDK, otherwise use Xcode's current default.
if [[ "$(uname -s)" == "Darwin" && -z "${SDKROOT:-}" ]]; then
  export SDKROOT="$(xcrun --show-sdk-path)"
fi

# Two cargo invocations, not twenty. The old loop ran `cargo test` from inside
# every crates/* directory, which predates the workspace: each run was its own
# cargo start-up and fingerprint pass (and, before the workspace, its own
# target/). `-p 'atlas-*'` selects the workspace MEMBERS matching the glob —
# the 19 Atlas crates, with their `tests/` dirs and doctests — and never the
# vendored engine (64 of its manifests carry their own suites; a bare
# `--workspace` would run them all). atlas-kb-server is workspace-excluded and
# is compiled at runtime by `knowledge_export`, so it is not tested here.
echo "==> crates/atlas-* (unit + integration + doctests)"
cargo test -p 'atlas-*'

# `--lib` only for the app crate: `-p atlas` alone would also link the `atlas`
# binary's own test harness, a second full-size link for nothing.
echo "==> src-tauri --lib"
cargo test -p atlas --lib
