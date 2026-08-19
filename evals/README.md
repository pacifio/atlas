# Atlas evals — the M0 harness

The eval harness from `plans/cersei-harness-roadmap.md` §4.3: it runs the
native Cersei agent headlessly against a task suite and reports the numbers
the roadmap's gates read (pass rate, ghost-run rate, edit-failure rate,
tokens, cost). Code lives in `crates/atlas-evals`; this directory holds the
data.

## Layout

- `tasks/<bucket>/<id>/` — one directory per task: `task.json` (spec),
  `prompt.md` (what the agent is told), optional `mutate.patch` (applied to
  the fresh workspace before the agent starts), `verify.patch` /
  `verify.sh` (the hidden verifier), `fixture/` (for fixture-kind tasks).
- `suites/<name>.json` — named task lists with a default run count.
- `runs/` (gitignored) — one directory per sweep: `meta.json` +
  `results.jsonl`, one line per (task, model, run).
- `harvest/` (gitignored) — output of `atlas-evals harvest`: per-session
  baseline metrics and retrieval query/label candidates mined from Claude
  Code and Cersei session logs (contract C4). Both output dirs carry real
  prompt and command content and must stay local.

## Buckets

- **edit** — omp-style micro-bench: a pinned rev of this repo is mutated by
  `mutate.patch`; the prompt spells out the exact restoration; verification
  is `git diff --exit-code` (byte-exact). Measures the edit layer in
  isolation — cheap, run freely.
- **history** — real fix commits from this repo, reverted: the workspace is
  the fix's parent rev, the prompt is a bug report, and verification
  injects the fix commit's tests (`verify.patch`) and runs them.
- **feature** — small scoped features in fixture projects with a hidden
  behavioral verifier script.

## Running

```sh
cd crates/atlas-evals
cargo run -- list
cargo run -- run --suite smoke --models anthropic/claude-sonnet-4-5
cargo run -- report --sweep <sweep-id> [--baseline <sweep-id>]
cargo run -- harvest
```

Models are provider-qualified (`provider/model`, providers per
`atlas-cersei/src/provider.rs`). Keys come from the app's `byok-keys.json`
(the runner reuses what Atlas already has), overridden by `*_API_KEY` env
vars. Sessions run in bypass permission mode inside the normal sandbox
tier, one detached git worktree (or fixture copy) per run, with a hard
timeout, a per-run cost cap (`--max-cost-per-run`, default $2) and a
sweep-level cap (`--max-cost-sweep`, default $25) that stops scheduling
when crossed.

Sweep sizes (roadmap decision 2): the `smoke` suite is the cheap
run-freely tier; the full sweep (≈50 tasks × 3 models × 3 runs) is
reserved for milestone gates and prices itself on its first run.

## Metrics

Per-turn metrics come from the `atlas::harness` tracing line the product
itself emits (`TELEMETRY.md`) — the runner installs a capture layer rather
than inventing its own schema. A **ghost run** is a run whose agent
finished normally (`end_turn`) but whose verifier failed — the roadmap's
"claimed done, wasn't" signal.

## Adding a task

Create `tasks/<bucket>/<id>/` with `task.json` + `prompt.md` (+ patches /
fixture), then run the suite-validation test, which loads every task and
dry-runs workspace preparation:

```sh
cd crates/atlas-evals && cargo test --test suite_valid
```
