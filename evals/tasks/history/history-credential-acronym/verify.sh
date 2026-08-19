# Runs in the workspace root after verify.patch injected the fix commit's
# tests.
export CARGO_TARGET_DIR="${ATLAS_EVALS_CACHE:-$HOME/.cache/atlas-evals}/target/history-credential-acronym"
cd crates/atlas-redact
exec cargo test --lib credential
