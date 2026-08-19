# Hidden behavioral verifier — the agent never sees this file. Runs in the
# workspace root (the fixture crate).
set -u
export CARGO_TARGET_DIR="${ATLAS_EVALS_CACHE:-$HOME/.cache/atlas-evals}/target/feature-wordfreq-top"

fail() { echo "verify: $1" >&2; exit 1; }

cargo test --quiet || fail "existing or new tests fail"
cargo build --quiet || fail "build fails"
BIN="$CARGO_TARGET_DIR/debug/wordfreq"

# Baseline behavior unchanged without the flag.
out=$(printf 'b a b c b a' | "$BIN") || fail "plain run exited non-zero"
[ "$out" = "b 3
a 2
c 1" ] || fail "plain output changed: $out"

# --top limits rows.
out=$(printf 'b a b c b a' | "$BIN" --top 2) || fail "--top 2 exited non-zero"
[ "$out" = "b 3
a 2" ] || fail "--top 2 wrong output: $out"

# --top larger than the row count prints everything.
out=$(printf 'x y' | "$BIN" --top 10) || fail "--top 10 exited non-zero"
[ "$out" = "x 1
y 1" ] || fail "--top 10 wrong output: $out"

# Invalid N → exit code 2 and something on stderr.
for bad in 0 -1 abc; do
  err=$(printf 'a' | "$BIN" --top "$bad" 2>&1 >/dev/null)
  code=$?
  [ "$code" -eq 2 ] || fail "--top $bad exited $code, want 2"
  [ -n "$err" ] || fail "--top $bad printed nothing to stderr"
done

# Missing N and unknown flags are also usage errors.
printf 'a' | "$BIN" --top >/dev/null 2>&1
[ $? -eq 2 ] || fail "--top with no value should exit 2"
printf 'a' | "$BIN" --bogus >/dev/null 2>&1
[ $? -eq 2 ] || fail "unknown flag should exit 2"

exit 0
