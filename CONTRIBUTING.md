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

Don't open a public issue for a vulnerability or a potential attack vector. See [SECURITY.md](.github/SECURITY.md) for how to report it privately.

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

There are two ways to run a source build, and they differ in whose data they use:

- **`bun run dev:app`: the dev profile.** This is the normal way to work. It runs as **Atlas Dev** (bundle identifier `dev.atlas.ide.dev`, from `src-tauri/tauri.dev.conf.json`), with its own app data dir, its own `<project>/.atlas-dev/` instead of `.atlas/`, `~/.atlas-dev/` instead of `~/.atlas/`, and `~/.config/atlas-dev/` instead of `~/.config/atlas/`. It never touches an installed Atlas's data, so it is safe beside one on the same projects. It keeps `.atlas-dev/` out of git through `.git/info/exclude` rather than your projects' `.gitignore`, and it never checks for or installs updates or refreshes the `atlas` CLI helper. A fresh dev profile starts empty: no history, settings, sign-in or knowledge notes. To start it over, `bun run clean:app:dev` wipes Atlas Dev's data only; `bun run clean:app` wipes the installed Atlas's. A bundled skill both builds ship under one name (`remember`) is installed by Atlas Dev only when it is missing, so it never overwrites the installed Atlas's copy: to try a change to one, delete it from `~/.agents/skills` first.
- **`bun run tauri dev` (or `cargo run`): no overlay, so the default profile, running against your real data** — the same thread history, settings and `.atlas/` directories as an installed Atlas. Use it on purpose, for example to reproduce a user's state, and not by accident.

`crates/atlas-profile` derives every name from the bundle identifier the binary was built with. New code that needs Atlas's directory goes through `atlas_profile::dir_name()` / `dir_in(root)` (and `config_dir_name()` for `~/.config/atlas`), never a literal `".atlas"` or `"atlas"` (`tests/dev-profile.test.ts` checks). Switching between `cargo check` / rust-analyzer and `bun run dev:app` reruns `tauri-build` and recompiles the `atlas` crate each time, because the two pass a different `TAURI_CONFIG`; if that gets in your way, give rust-analyzer its own target dir (`rust-analyzer.cargo.targetDir`).

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

Most open-source projects merge every PR straight into `main`, because `main` is deployed continuously — there's no fixed "next release," just a constantly moving target. Atlas doesn't work that way: it ships as a numbered, installable build with an auto-updater, so `main` has to always equal exactly what's been released, nothing ahead of it. That means work needs somewhere to collect _before_ it becomes a release, instead of landing on `main` directly.

That somewhere is a version branch — one per upcoming release (`0.2.5`, `0.2.6`, …). PRs target the version branch, not `main`. Once the version branch is ready to ship, it gets merged into `main` in a single PR, and that merge _is_ the release.

```
you/fix-sidebar-collapse ──┐
you/add-vim-keybindings ───┼──►  0.2.5  ──►  main     (this merge = the 0.2.5 release)
someone/fix-x ──────────────┘
```

| Branch               | Purpose                                         | Merges into                           |
| -------------------- | ----------------------------------------------- | ------------------------------------- |
| `main`               | Always equals the latest release, nothing more  | —                                     |
| `0.2.4`, `0.2.5`, …  | Collects everything going into the next release | `main`, and that merge is the release |
| `<you>/<short-slug>` | One issue's worth of work                       | The current version branch            |

PR straight into `main` only when the change has no version-branch dependency and doesn't need to wait for the next release — a doc fix or a one-line hotfix, say. When in doubt, target the version branch.

**An issue is closed when its fix merges into the version branch**, not when it reaches `main`. GitHub only auto-closes `Fixes #N` on merges into the default branch, and releases go out when they're ready rather than on a schedule, so waiting for `main` would leave fixed issues looking open for weeks — and invite a second PR for the same fix. The maintainer who merges closes the issue by hand, with a comment naming the PR and the branch. If an open issue looks unclaimed, check the version branch's open and merged PRs before starting on it.

Releases are tagged `alpha-X.Y.Z`, with occasional `exp-X.Y.Z-X.Y.Z` snapshots.

### Versioning

The version lives in four places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the Settings "About" label in `src/features/settings/components/settings-panel.tsx`. The scripts change all four together, and refresh `Cargo.lock`'s entry for the app so CI's `--locked` builds still run.

```bash
bun run bump          # patch bump: 0.2.3 -> 0.2.4
bun run bump 0.3.0    # explicit version
bun run debump        # inverse of bump
```

Run `bun run bump` (`scripts/bump.sh`) once per release, on the version branch, before opening the PR into `main`. Never edit the four files by hand.

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
bun run ci:local --linux              # every Linux job in the container, not just the ones that need it
bun run ci:local --native             # no container at all
bun run ci:local --shell              # a shell in that container
```

Jobs run on your machine, except:

- **A job CI runs on macOS** (the app) is skipped on any other OS.
- **The app's Linux and Windows compile checks** run only on their own OS. On a
  Mac the Linux one goes to the container.
- **The jobs that need Linux itself** go to a container built from
  `scripts/ci-linux/Dockerfile`, with Rust, Bun and Node at the pinned versions.
  That means `atlas-native-agent`, whose suites drive the engine's sandbox, and
  the app's Linux compile check. On Linux the sandbox is bubblewrap, landlock
  and seccomp; on a Mac it's seatbelt, which allows what landlock denies, so a
  macOS run passes where Linux fails. The container starts only when the plan
  includes one of these jobs.

Code that only _compiles_ on Linux needs no container. Crates flagged `cross` in
`.github/ci-crates.json` have no C in their dependency tree. When their Linux
job runs on a Mac, each clippy step is repeated with
`--target aarch64-unknown-linux-gnu`; that type-checks the `cfg(target_os =
"linux")` arms a Mac otherwise never compiles. CI also clippies the same crates
for Windows. Both targets' standard libraries come from rust-toolchain.toml's
`targets`, which `rustup toolchain install` adds.

With no container runtime running, the jobs that need Linux run on your machine
instead (the app's Linux check is skipped), and the summary names what went
untested. The container's target dir, cargo registry and a Linux `node_modules`
live in Docker volumes, so only the first run is cold. Your checkout's own
`node_modules` and `dist/` are left alone.

- **Any Docker-compatible runtime works**: Docker Desktop, OrbStack, Colima,
  or Podman (`ATLAS_CI_DOCKER=podman`). Give its VM enough memory for a
  parallel Rust build.
- **A slow Ubuntu mirror** makes the image's one-time `apt-get install` crawl.
  `ATLAS_CI_APT_MIRROR=<url>` points it at any mirror of `ubuntu-ports` (arm64)
  or `ubuntu` (x86-64), e.g. `http://mirror.sg.gs/ubuntu-ports`. Use `http://`:
  the base image has no CA certificates yet, and apt checks every package
  against the signed Release file either way. It doesn't change the image tag.
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
and `-dist` are per checkout. `docker volume rm` them to start cold. A deleted
worktree leaves its small per-checkout volumes behind, and a Rust or Bun pin
change leaves the old `atlas-ci-linux:*` image; `ci:local` prints the
`docker image rm` for that.

**Disk.** Stable cargo never deletes anything from `target/`; left alone it
reached 67 GB, more than half of it unusable. `bun run ci:local` runs
`scripts/target-gc.sh` before its jobs, on your `target/` and on the
container's cache volume:

- **After a Rust upgrade** in `rust-toolchain.toml`, it removes everything
  the old compiler built, which can't be reused. After the 1.98 → 1.99 bump
  that was 41 GB plus 17 GB of incremental state. Only an upgrade triggers it,
  so alternating with a worktree on an older pin doesn't throw builds away.
- **Once a week**, it removes artifacts cargo hasn't used in 30 days: mostly
  old dependency versions left behind by lockfile bumps. Getting one wrong
  costs a rebuild, never a broken build.

Both use [`cargo-sweep`](https://github.com/holmgr/cargo-sweep), which the
container image ships with. On your machine, install it once with
`cargo install cargo-sweep`; without it, an upgrade still clears incremental
state and prints the hint. Run the script by hand any time with
`bash scripts/target-gc.sh target`.

Linting each crate on its own, as CI does, keeps a few builds of shared
dependencies with different feature sets. That's expected, and they're reused
from run to run.

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
command name and payload. Whether the command _exists_ is already covered.

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

Participation is covered by our [Code of Conduct](.github/CODE_OF_CONDUCT.md).
