#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# apple-sys needs the active macOS SDK while compiling native dependencies.
# Respect an explicitly selected SDK, otherwise use Xcode's current default.
if [[ "$(uname -s)" == "Darwin" && -z "${SDKROOT:-}" ]]; then
  export SDKROOT="$(xcrun --show-sdk-path)"
fi

for crate_dir in "$repo_root"/crates/*; do
  [[ -f "$crate_dir/Cargo.toml" ]] || continue
  echo "==> Testing crates/$(basename "$crate_dir")"
  (cd "$crate_dir" && cargo test)
done

echo "==> Testing src-tauri --lib"
(cd "$repo_root/src-tauri" && cargo test --lib)
