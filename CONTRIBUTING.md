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
- [Rust](https://rustup.rs/) via rustup, which installs the version `rust-toolchain.toml` pins on first use
- Xcode Command Line Tools

We suggest using [mise](https://mise.jdx.dev/) to manage Bun and Node — the repo ships a `mise.toml` pinning both, and CI installs exactly those, so `mise install` gives you the versions CI tests with. Not required; `bun run ci:local` warns when your versions differ from the pins.

**No API keys, no `.env` file, no account.** Atlas builds and runs from a clean clone:

```bash
git clone git@github.com:pacifio/atlas.git
cd atlas
bun install
bun run dev:app
```

The first Rust compile takes a few minutes; after that, seconds. `bun run dev:app` hot-reloads the frontend on save — Rust changes need a restart.

That's enough to build and run Atlas. If you're planning to submit a change and don't have write access, clone your **fork** instead of `pacifio/atlas` directly — see "Fork, branch, PR" below.

Other commands you'll use:

```bash
bun run dev             # Vite only, in your browser, on a fake backend — see "UI work in the browser"
bun run format          # oxfmt --write on src/
bun run lint            # oxlint on src/
```

A husky pre-commit hook runs `lint-staged` (oxfmt + oxlint on staged files) plus `bun run typecheck`, so most formatting/lint issues are caught before they ever reach CI (see Verification below).

### UI work in the browser

`bun run dev` runs the whole app at `localhost:1420` in a normal browser. No Rust is running: a dev-only fake backend in `src/dev/mock-backend/` answers every `invoke()` and `listen()` with made-up data. You get instant hot reload, and a coding agent can open the page and check its own work.

- **Pick a state** with `?scenario=<name>`, e.g. `?scenario=git-conflict` or `?scenario=chat-tools`. The list is in `scenarios/index.ts`. Without one you get a project with ordinary data.
- **Need a state that doesn't exist yet?** Add a scenario file with fake answers for the commands that screen calls. Don't set up a real repo or start a real agent session just to see a screen.
- **Blank or broken panel?** Check the badge in the bottom-right corner. It lists commands nothing answered yet (they return `null`). Add an answer to `scenarios/base.ts` or to your scenario.
- **Type your fakes** with the frontend's own API types, so `bun run typecheck` catches it when Rust changes a return shape.

The fake backend is never part of a build, and it switches itself off inside the Tauri window. It can't fake the Browser tab, drag-and-drop from Finder or native window controls, and Chrome doesn't render exactly like the app's WebKit view. Check your change in `bun run dev:app` before opening the PR.

If you're working on the **Claude Code** agent specifically, you also need the `claude` CLI on your `PATH`. The native Atlas agent needs nothing extra.

`.env` is optional — copy `.env.example` only if you want to point telemetry at your own PostHog project. Left blank, telemetry is permanently inert.

## Fork, branch, PR

Every change comes in through a pull request. Maintainers branch directly on `pacifio/atlas`; everyone else forks first. The rest of the flow is identical either way.

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

The version lives in four places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the Settings "About" label in `src/features/settings/components/settings-panel.tsx`. The scripts change all four together, and refresh `Cargo.lock`'s entry for the app so CI's `--locked` builds still run.

```bash
./bump.sh          # patch bump: 0.2.3 -> 0.2.4
./bump.sh 0.3.0    # explicit version
./debump.sh        # inverse of bump.sh
```

Run `bump.sh` once per release, on the version branch, before opening the PR into `main`. Never edit the four files by hand.

## Verification

```bash
bun run lint                       # oxlint on src/
bun run format:check               # oxfmt --check on src/
bun run typecheck                  # frontend typecheck (app + test code)
bun run test                       # frontend and cross-cutting tests
bun run test:rust                  # every Rust crate + src-tauri --lib
cargo check --workspace            # Rust typecheck: every workspace member + the app
```

Before pushing, `bun run ci:local` runs what CI would run for your branch, the
way CI runs it: the jobs and commands are read out of
`.github/workflows/ci.yml`, the jobs a change affects are planned by the same
script CI uses, and every crate is tested and linted (clippy, CI's flags) from
its own directory. `bun run test:rust` is the quicker subset — no clippy, and
all crates in one cargo invocation — so it can pass where CI fails. Rust, Bun
and Node are pinned (`rust-toolchain.toml`, `mise.toml`) to the versions CI
installs; `ci:local` warns when yours differ.

```bash
bun run ci:local                      # the jobs CI would run for this branch
bun run ci:local --all                # every job
bun run ci:local atlas-git frontend   # chosen jobs, by the names CI shows
bun run ci:local --list               # what it would run, without running it
bun run ci:local --linux              # CI's Linux jobs in a Linux container
bun run ci:local --shell              # a shell in that container
```

By default every job runs on your machine, and a job CI runs on macOS (the app)
is skipped on any other OS. So is the app's Linux compile check, except on
Linux: on a Mac it would only repeat the macOS build. CI
runs every other job on arm64 Ubuntu, so from a Mac or Windows the Linux-only
paths go untested; the engine's bubblewrap sandbox and code gated on
`target_os = "macos"` are the ones that bite. `--linux` runs those jobs in a container built
from `scripts/ci-linux/Dockerfile`, with Rust, Bun and Node at the pinned
versions. It's opt-in because the first run is a cold build; the target dir,
cargo registry and a Linux `node_modules` then live in Docker volumes for that
checkout, and later runs are incremental. Your checkout's own `node_modules`
and `dist/` are left alone.

- **Any Docker-compatible runtime works**: Docker Desktop, OrbStack, Colima,
  or Podman (`ATLAS_CI_DOCKER=podman`). Give its VM enough memory for a
  parallel Rust build.
- **Windows**: clone inside WSL2 and run from there. A checkout on the Windows
  filesystem is bind-mounted over a slow bridge, too slow for a build.
- **x86-64 hosts** get an x86-64 container, never an emulated arm64 one
  (emulation is several times slower). Results transfer to CI except for
  arch-specific code, and a run there is useful in its own right: Linux
  releases ship x86-64 builds, which no CI job tests.
- **Linux hosts** already run the crate jobs natively. `--linux` still buys
  CI's exact toolchain and Ubuntu userland, and installs bubblewrap for you.
  On Linux, Docker needs AppArmor and seccomp relaxed for the sandbox, which
  `ci:local` does per container.

Volumes are named `atlas-ci-<hash>-*`. The build cache (`-cache`) is one per
clone, shared by its worktrees, so a new worktree starts warm; `-node-modules`
and `-dist` are per checkout. `docker volume rm` them to start cold.

A pre-push hook runs the full `bun run test`; pre-commit runs only `tests/`.

Rust tests run offline and need no API keys. Every crate under `crates/` except
`atlas-kb-server` (see below) is a member of the root cargo workspace, sharing
one `Cargo.lock` and one `target/` at the repo root, so `-p <crate>` works from
anywhere — as does running from inside the crate's own directory, which is what
CI does:

```bash
cargo test -p atlas-native-agent                          # the native agent
cargo test -p atlas-native-agent --test engine_turn       # a single file
cd crates/atlas-native-agent && cargo test                # same thing, from the crate
```

Run `bun run test:rust` from the repository root to test every crate and the
Tauri library in one pass; it stops at the first failure.

The exception, `crates/atlas-kb-server`, is a template binary the
knowledge-export command compiles on demand at runtime under its own release
profile. Profiles are workspace-global, so joining the workspace would rebuild
it under the app's — hence it stays out, keeps its own `Cargo.lock`, and is
built with `--manifest-path`.

Frontend tests run under Vitest:

```bash
bun run test                            # everything
bun run test src/lib/time-ago.test.ts   # one file
bun run test:watch                      # re-run on save
```

Tests live next to the code they cover (`src/lib/time-ago.test.ts`), except for
ones that check the repo as a whole, which live in `tests/`. Three of those run on
every PR and are worth knowing about:

- `tests/ipc-contract.test.ts` — every `invoke("name")` in the frontend resolves
  to a registered `#[tauri::command]`, every command is wired into
  `generate_handler!`, and every registered command has a frontend caller.
  Rename a command without updating its callers and this is what tells you,
  instead of a dead button at runtime; leave a command behind after its last
  caller goes and it tells you that too.
- `tests/ci-coverage.test.ts` — every crate in `crates/` is in the CI matrix
  (`.github/ci-crates.json`), so a new crate can't merge with its tests unrun.
- `tests/ci-affected.test.ts` — CI runs only the Rust jobs a change affects,
  planned by `scripts/ci-affected.mjs` from the diff and the crate dependency
  graph. A crate that reads a file outside its own directory (`include_str!`
  of something under `docs/`, a test walking the repo) has to declare it in
  that script's `EXTRA_INPUTS`, or an edit to that file would skip the crate's
  tests. This suite finds such reads and tells you when one is undeclared.
  To see what CI would run for your branch:
  `node scripts/ci-affected.mjs --base origin/<version-branch>`.

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
