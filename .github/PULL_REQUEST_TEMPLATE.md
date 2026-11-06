<!--
Thanks for the PR. Please read CONTRIBUTING.md if you haven't already.

Target `main`. The PR is squash-merged, so its title becomes the commit
message: write it as a Conventional Commit, e.g.
`fix(terminal): keep the close button clickable while dragging`.
See CONTRIBUTING.md's "Branching model" section.
-->

### What?

### Why?

### How?

Fixes #

## Checklist

Only the things CI can't check for you:

- [ ] Targets `main`, with a Conventional Commit title (`feat(scope): …`, `fix(scope): …`)
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] You've run the app and used the change in a window

CI runs, on every PR: `bun run lint`, `bun run format:check`, `bun run
typecheck`, `bun run test` and `bun run build`; `cargo test` plus one clippy
pass for every crate under `crates/`, each in its own job (`-D warnings` for
the crates flagged `clippy: true` in `ci.yml`, the workspace lint table for the
rest), plus a Windows-target clippy pass for the crates flagged `cross`;
`cargo test --lib` and clippy for `src-tauri` on macOS, and clippy for it on
Linux and Windows; and the engine
dialect (`atlas-engine-api`) with the engine crates Atlas has edited. So there are no
boxes for those. Locally, `bun run test:rust` runs a subset of CI's Rust tests
(its header says what it skips) and no clippy. `bun run ci:local` runs what CI
would for your branch, clippy included, and sends the jobs that need Linux to a
container.
What CI still can't judge is whether the change actually works in a window, and
whether the behaviour you added is covered by a test.

If this adds a top-level dependency or touches the telemetry pipeline, say so in **Why?** above — both need discussion, and telemetry changes need `TELEMETRY.md` updated to match.
