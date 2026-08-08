<!--
Thanks for the PR. Please read CONTRIBUTING.md if you haven't already.

## Which branch should this target?

Atlas ships versioned installable builds, so `main` always equals the latest
release — work collects on a version branch (e.g. `0.2.5`) first, and the
merge of that branch into `main` is the release itself.

- Target the **current version branch** for anything that isn't a small,
  self-contained fix.
- Target **`main`** directly only if the change has no version-branch
  dependency and doesn't need to wait for the next release (a doc fix, a
  one-line hotfix).

See CONTRIBUTING.md's "Branching model" section if you're not sure which
applies.
-->

### What?

### Why?

### How?

Fixes #

## Checklist

Only the things CI can't check for you:

- [ ] Targets the current version branch, unless it's a small standalone fix
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] You've run the app and used the change in a window

CI now runs, on every PR: `bun run lint`, `bun run format:check`, `bun run
typecheck`, `bun run test`, `bun run build`, `cargo test` for all 14 crates,
and `cargo test` for `src-tauri`. So there are no boxes for those — if it
compiles and passes locally, CI is checking it too.
What CI still can't judge is whether the change actually works in a window, and
whether the behaviour you added is covered by a test.

If this adds a top-level dependency or touches the telemetry pipeline, say so in **Why?** above — both need discussion, and telemetry changes need `TELEMETRY.md` updated to match.
