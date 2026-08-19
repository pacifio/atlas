# Runs in the workspace root after verify.patch injected the fix commit's
# tests. A shared target dir keeps repeat runs of this task warm; the
# source tree itself is per-run and isolated.
export CARGO_TARGET_DIR="${ATLAS_EVALS_CACHE:-$HOME/.cache/atlas-evals}/target/history-late-assistant-output"
cd crates/atlas-agents
exec cargo test --lib actor::tests
