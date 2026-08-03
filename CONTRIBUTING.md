# Contributing to Atlas

Thanks for wanting to help. Below is how to do it, and everything here applies to every contributor equally.

If you're not sure where to begin, `#dev` on [Discord](https://discord.gg/GmnFggaPfP) is the fastest way to get an answer.

## Where to start

[`good first issue`](https://github.com/pacifio/atlas/labels/good%20first%20issue) and [`help wanted`](https://github.com/pacifio/atlas/labels/help%20wanted) are labelled for exactly this.

Areas where help goes furthest right now:

- **Linux and Windows testing** of the production bundle — terminal font, PATH resolution, general GUI behaviour.
- **More ACP agents.** `atlas-acp` already speaks the wire format, so adding Gemini CLI, OpenCode, or Kilo Code is mostly plugin discovery and auth.
- **LSP support** for diagnostics and go-to-definition in the editor.
- **MCP server integration** for tool-call extensibility.
- **Themes** and additional colour palettes.

## Reporting a bug

Check [open and closed issues](https://github.com/pacifio/atlas/issues?q=is%3Aissue) first. If one already covers it, a 👍 reaction is more useful than a duplicate.

The fastest way to report one is the **feedback button** in the app (status bar, or Settings) — its "Open a GitHub issue" link pre-fills the Bug Report form from whatever you typed. Filing directly on GitHub works the same way.

The form only requires one field: a freeform description. Write as much or as little as you have — a one-line note is a fine issue, and so is a long writeup with source references. If you have them, your Atlas version (Settings → About), your OS and version, which agent was selected, and how to trigger it all help, but none of them block you from filing.

## Security issues

Don't open a public issue for a vulnerability or a potential attack vector. See [SECURITY.md](SECURITY.md) for how to report it privately.

## Documentation

Open a PR directly. No issue needed for typos, clarifications, or filling in something that's missing.

## New features

Open an issue first, or bring it to `#feature-requests` on [Discord](https://discord.gg/GmnFggaPfP).

Most Atlas features cross three layers — React UI, a Tauri command, and a workspace crate — so agreeing the approach first saves you from building something that has to be restructured. [ARCHITECTURE.md](ARCHITECTURE.md) covers how those layers fit together.

Match the patterns already in the codebase: feature folder under `src/features/<feature>/`, Zustand store wrapped in `createSelectors`, Tailwind composed through `cn()`, IPC verbs grouped into a single `commands/<domain>.rs`. If your change doesn't fit any of them, propose the structure in the issue.

New heavy dependencies need discussion first. The current list is deliberate.

## Design changes

Share the proposal in the issue before implementing anything that changes UI or UX.

Atlas has a lot of surfaces — a change that looks right in one panel often reads wrong across the other twelve. A design pass up front is faster than a rewrite after review.

## Quickstart

**macOS is the only currently-supported platform.** Linux and Windows build from the same Tauri codebase but are untested — a Windows build is planned, and reports from either OS are genuinely welcome in the meantime.

You need:

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/), stable
- Xcode Command Line Tools

**No API keys, no `.env` file, no account.** Atlas builds and runs from a clean clone:

```bash
git clone git@github.com:pacifio/atlas.git
cd atlas
bun install
bun run dev:app
```

The first Rust compile takes a few minutes; after that, seconds. `bun run dev:app` hot-reloads the frontend on save — Rust changes need a restart.

That's enough to build and run Atlas. If you're planning to submit a change, clone your **fork** instead of `pacifio/atlas` directly — see "Fork, branch, PR" below.

Other commands you'll use:

```bash
bun run dev             # Vite only, no Tauri shell — fast for pure UI work, but invoke() calls fail
bun run format          # Prettier on src/
```

`bun run lint` fails on a clean checkout — there's no ESLint 9 flat config in the repo yet. Use `bunx tsc --noEmit` as the frontend gate (see Verification below).

If you're working on the **Claude Code** agent specifically, you also need the `claude` CLI on your `PATH`. The native Atlas agent needs nothing extra.

`.env` is optional — copy `.env.example` only if you want to point telemetry at your own PostHog project. Left blank, telemetry is permanently inert.

## Fork, branch, PR

Every change comes in through a fork and a pull request.

```bash
# 1. Fork pacifio/atlas on GitHub, then clone your fork
git clone git@github.com:<you>/atlas.git
cd atlas

# 2. Point `upstream` at the canonical repo
git remote add upstream git@github.com:pacifio/atlas.git
git fetch upstream
```

Next, find the current version branch — check the [branch list on GitHub](https://github.com/pacifio/atlas/branches) and look for the highest-numbered one (e.g. `0.2.5`). Ask in `#dev` on Discord if it's not obvious.

```bash
# 3. Branch from it, not from main
git checkout -b <you>/short-slug upstream/0.2.5

# 4. Push to your fork, then open the PR against that same version branch
git push -u origin <you>/short-slug
```

Name your branch `<you>/<short-slug>` — a few words describing the change, e.g. `alex/fix-sidebar-collapse`. If there's a GitHub issue for it, lead with the number: `alex/42-fix-sidebar-collapse`.

To pick up changes made while you were working:

```bash
git fetch upstream
git rebase upstream/0.2.5
```

Leave **Allow edits from maintainers** checked when you open the PR. It lets small fixes land without another round trip.

## Branching model

Most open-source projects merge every PR straight into `main`, because `main` is deployed continuously — there's no fixed "next release," just a constantly moving target. Atlas doesn't work that way: it ships as a numbered, installable build with an auto-updater, so `main` has to always equal exactly what's been released, nothing ahead of it. That means work needs somewhere to collect *before* it becomes a release, instead of landing on `main` directly.

That somewhere is a version branch — one per upcoming release (`0.2.5`, `0.2.6`, …). PRs target the version branch, not `main`. Once the version branch is ready to ship, it gets merged into `main` in a single PR, and that merge *is* the release.

```
you/fix-sidebar-collapse ──┐
you/add-vim-keybindings ───┼──►  0.2.5  ──►  main     (this merge = the 0.2.5 release)
someone/fix-x ──────────────┘
```

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | Always equals the latest release, nothing more | — |
| `0.2.4`, `0.2.5`, … | Collects everything going into the next release | `main`, and that merge is the release |
| `<you>/<short-slug>` | One issue's worth of work | The current version branch |

PR straight into `main` only when the change has no version-branch dependency and doesn't need to wait for the next release — a doc fix or a one-line hotfix, say. When in doubt, target the version branch.

Releases are tagged `alpha-X.Y.Z`, with occasional `exp-X.Y.Z-X.Y.Z` snapshots.

### Versioning

The version lives in four places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the Settings "About" label in `src/features/settings/components/settings-panel.tsx`. The scripts change all four together.

```bash
./bump.sh          # patch bump: 0.2.3 -> 0.2.4
./bump.sh 0.3.0    # explicit version
./debump.sh        # inverse of bump.sh
```

Run `bump.sh` once per release, on the version branch, before opening the PR into `main`. Never edit the four files by hand.

## Verification

```bash
bun run typecheck                  # frontend typecheck (app + test code)
bun run test                       # frontend and cross-cutting tests
cd src-tauri && cargo check        # Rust typecheck, including every crates/* dependency
```

Rust tests run offline and need no API keys. Each crate under `crates/` is its own standalone package (its own `Cargo.lock`, not a workspace member of `src-tauri`), so tests run from inside the crate's own directory — not with `-p <crate>` from `src-tauri`:

```bash
cd crates/atlas-cersei && cargo test                      # the native agent
cd crates/atlas-cersei && cargo test --test tools_eval    # a single file
cd crates/atlas-acp && cargo run --example smoke          # ACP transport smoke test
```

Run `cargo test` from inside the directory of any crate you touched.

Frontend tests run under Vitest:

```bash
bun run test                            # everything
bun run test src/lib/time-ago.test.ts   # one file
bun run test:watch                      # re-run on save
```

Tests live next to the code they cover (`src/lib/time-ago.test.ts`), except for
ones that check the repo as a whole, which live in `tests/`. Two of those run on
every PR and are worth knowing about:

- `tests/ipc-contract.test.ts` — every `invoke("name")` in the frontend resolves
  to a registered `#[tauri::command]`, and every command is wired into
  `generate_handler!`. Rename a command without updating its callers and this is
  what tells you, instead of a dead button at runtime.
- `tests/ci-coverage.test.ts` — every crate in `crates/` is in the CI matrix, so
  a new crate can't merge with its tests unrun.

For a new IPC module, copy the pattern in
`src/features/settings/lib/byok-api.test.ts`: mock `invoke` and assert the
command name and payload. Whether the command *exists* is already covered.

Rendering and interaction still need a real window — Vitest covers logic and the
IPC seam, not the UI itself.

## Pull request checklist

Opening a PR pre-fills the checklist from the [PR template](.github/PULL_REQUEST_TEMPLATE.md) — work through it before asking for review.

## Telemetry

Atlas ships one narrow PostHog pipeline, in `src-tauri/src/telemetry/`. It's anonymous, coarse, and opt-out. Changing it has its own rules.

**Never sent, under any circumstance:**

- Prompt or response text
- File contents, or absolute paths
- Knowledge-base or chat content
- API keys and credentials
- Terminal input or output
- Browser URLs

New events need discussion in the issue before they're built, and any change to the pipeline updates [TELEMETRY.md](TELEMETRY.md) in the same PR.

## New markdown files

`.gitignore` ignores `*.md` apart from explicit exceptions, so a new doc won't show up in `git status`. Add it with `git add -f`, or add an exception to `.gitignore`.

## Code of conduct

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).
