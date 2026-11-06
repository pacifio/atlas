# Contributing to Atlas

Thanks for wanting to help. Below is how to do it, and everything here applies to every contributor equally.

If you're not sure where to begin, `#dev` on [Discord](https://discord.gg/GmnFggaPfP) is the fastest way to get an answer.

## Where to start

[`good first issue`](https://github.com/tryatlas/atlas/labels/good%20first%20issue) and [`help wanted`](https://github.com/tryatlas/atlas/labels/help%20wanted) are labeled for exactly this.

Areas where help goes furthest right now:

- **Linux and Windows testing** of the production bundle — terminal font, PATH resolution, general GUI behavior.
- **More ACP agents.** `atlas-acp` already speaks the wire format, so adding Gemini CLI, OpenCode, or Kilo Code is mostly plugin discovery and auth.
- **LSP support** for diagnostics and go-to-definition in the editor.
- **MCP server integration** for tool-call extensibility.
- **Themes** and additional color palettes.

## Reporting a bug

Check [open and closed issues](https://github.com/tryatlas/atlas/issues?q=is%3Aissue) first. If one already covers it, a 👍 reaction is more useful than a duplicate.

The fastest way to report one is the **feedback button** in the app (status bar, or Settings) — its "Open a GitHub issue" link pre-fills the Bug Report form from whatever you typed. Filing directly on GitHub works the same way.

The form only requires one field: a freeform description. Write as much or as little as you have — a one-line note is a fine issue, and so is a long writeup with source references. If you have them, your Atlas version (Settings → About), your OS and version, which agent was selected, and how to trigger it all help, but none of them block you from filing.

## Security issues

Don't open a public issue for a vulnerability or a potential attack vector. See [SECURITY.md](.github/SECURITY.md) for how to report it privately.

## Documentation

Open a PR directly. No issue needed for typos, clarifications, or filling in something that's missing.

## New features

Open an issue first, or bring it to `#feature-requests` on [Discord](https://discord.gg/GmnFggaPfP).

Most Atlas features cross three layers — React UI, a Tauri command, and a workspace crate — so agreeing the approach first saves you from building something that has to be restructured. [docs/architecture.md](docs/architecture.md) covers how those layers fit together.

Match the patterns already in the codebase: feature folder under `src/features/<feature>/`, Zustand store wrapped in `createSelectors`, Tailwind composed through `cn()`, IPC verbs grouped into a single `commands/<domain>.rs`. If your change doesn't fit any of them, propose the structure in the issue.

Split a new surface into a container and views. The container (`components/<name>.tsx`) reads stores, calls the `*-api.ts` wrappers and handles `atlas:*` events; the views (`components/views/<name>-view.tsx`) render from props and callbacks alone. A view that needs an agent's name or mark calls `useAgentMeta(id)` or takes it as a prop, never `agentMeta()`, which reads a store. `tests/view-purity-contract.test.ts` enforces this, because nothing else can see a view that quietly imports a store. [Containers and views](docs/architecture.md#containers-and-views) has the full rule.

New heavy dependencies need discussion first. The current list is deliberate.

## Design changes

Share the proposal in the issue before implementing anything that changes UI or UX.

Atlas has a lot of surfaces — a change that looks right in one panel often reads wrong across the other twelve. A design pass up front is faster than a rewrite after review.

Build UI from the `@tryatlas/design` primitives, scales and theme tokens ([design-system.md](docs/reference/design-system.md)). A change to a primitive, a shared scale or a theme key belongs in the [`tryatlas/design`](https://github.com/tryatlas/design) package, then a bump of desktop's pinned tag (ADR-0027); the few desktop-only scales (the titlebar height, the composer radius) stay in `src/styles/globals.css`. The design-system ratchet test fails on hand-written sizes and colours.

## Quickstart

**macOS and Linux are the supported platforms.** Linux support is what [docs/reference/linux-support.md](docs/reference/linux-support.md) says it is: glibc 2.35 or newer and WebKitGTK 4.1, shipped as deb, rpm, Arch, AppImage and tarball. Windows builds from the same Tauri codebase but is untested — a Windows build is planned, and reports are genuinely welcome in the meantime.

You need:

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/) via rustup, which installs the version `rust-toolchain.toml` pins on first use
- Xcode Command Line Tools

We suggest using [mise](https://mise.jdx.dev/) to manage Bun and Node — the repo ships a `mise.toml` pinning both, and CI installs exactly those, so `mise install` gives you the versions CI tests with. Not required; `bun run ci:local` warns when your versions differ from the pins.

**No API keys, no `.env` file, no account.** Atlas builds and runs from a clean clone:

```bash
git clone git@github.com:tryatlas/atlas.git
cd atlas
mise install     # optional, see above
bun install
bun run doctor   # checks your toolchain against the pins, with a fix hint for each miss
bun run dev:app
```

`bun run doctor` is quick and changes nothing: it compares Node, Bun and Rust with `mise.toml` and `rust-toolchain.toml`, checks the Xcode tools and git hooks, and warns about optional pieces (Docker, `cargo-sweep`) and an oversized `target/`. `dev:app` also runs `scripts/target-gc.sh` before it starts, so `target/` is tidied without `ci:local`; it only acts after a Rust upgrade or once a week, and a failure never blocks dev.

The repo commits shared VS Code settings in `.vscode/` (oxc as the formatter with format on save, rust-analyzer on its own target dir so it does not fight `dev:app` for the build lock) and recommends the matching extensions; `.editorconfig` covers other editors.

The first Rust compile takes a few minutes; after that, seconds. `bun run dev:app` hot-reloads the frontend on save — Rust changes need a restart.

There are two ways to run a source build, and they differ in whose data they use:

- **`bun run dev:app`: the dev profile.** This is the normal way to work. It runs as **Atlas Dev** (bundle identifier `dev.atlas.ide.dev`, from `src-tauri/tauri.dev.conf.json`), with its own app data dir, its own `<project>/.atlas-dev/` instead of `.atlas/`, `~/.atlas-dev/` instead of `~/.atlas/`, and `~/.config/atlas-dev/` instead of `~/.config/atlas/`. It never touches an installed Atlas's data, so it is safe beside one on the same projects. It keeps `.atlas-dev/` out of git through `.git/info/exclude` rather than your projects' `.gitignore`, and it never checks for or installs updates. A fresh dev profile starts empty: no history, settings, sign-in or knowledge notes. To start it over, `bun run clean:app:dev` wipes Atlas Dev's data only; `bun run clean:app` wipes the installed Atlas's. A bundled skill both builds ship under one name (`remember`) is installed by Atlas Dev only when it is missing, so it never overwrites the installed Atlas's copy: to try a change to one, delete it from `~/.agents/skills` first.
- **`bun run tauri dev` (or `cargo run`): no overlay, so the default profile, running against your real data** — the same thread history, settings and `.atlas/` directories as an installed Atlas. Use it on purpose, for example to reproduce a user's state, and not by accident.

`crates/atlas-profile` derives every name from the bundle identifier the binary was built with. New code that needs Atlas's directory goes through `atlas_profile::dir_name()` / `dir_in(root)` (and `config_dir_name()` for `~/.config/atlas`), never a literal `".atlas"` or `"atlas"` (`tests/dev-profile.test.ts` checks). Switching between `cargo check` / rust-analyzer and `bun run dev:app` reruns `tauri-build` and recompiles the `atlas` crate each time, because the two pass a different `TAURI_CONFIG`; if that gets in your way, give rust-analyzer its own target dir (`rust-analyzer.cargo.targetDir`).

That's enough to build and run Atlas. If you're planning to submit a change and don't have write access, clone your **fork** instead of `tryatlas/atlas` directly — see "Fork, branch, PR" below.

Other commands you'll use:

```bash
bun run dev             # Vite only, in your browser, on a fake backend — see "UI work in the browser"
bun run format          # oxfmt --write on src/, tests/, scripts/
bun run lint            # oxlint on src/, tests/, scripts/
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

Every change comes in through a pull request. Maintainers branch directly on `tryatlas/atlas`; everyone else forks first. The rest of the flow is identical either way.

```bash
# 1. Fork tryatlas/atlas on GitHub, then clone your fork
git clone git@github.com:<you>/atlas.git
cd atlas

# 2. Point `upstream` at the canonical repo
git remote add upstream git@github.com:tryatlas/atlas.git
git fetch upstream
```

```bash
# 3. Branch from main
git checkout -b <you>/short-slug upstream/main

# 4. Push to your fork, then open the PR against main
git push -u origin <you>/short-slug
```

Name your branch `<you>/<short-slug>`: a few words describing the change, e.g. `alex/fix-sidebar-collapse`. If there's a GitHub issue for it, lead with the number: `alex/42-fix-sidebar-collapse`. Title the PR as a Conventional Commit (see "Branching model" below).

To pick up changes made while you were working:

```bash
git fetch upstream
git rebase upstream/main
```

Leave **Allow edits from maintainers** checked when you open the PR. It lets small fixes land without another round trip.

## Branching model

Atlas is **trunk-based**. There is one shared branch, `main`, and every pull request targets it. A release is not a branch: it is a **tag**, a fixed bookmark on one commit of `main`.

Two words this section leans on:

- A **branch** is a name that points at the newest commit in a line of work, and moves forward as commits are added.
- A **tag** is a name for one commit that never moves. `alpha-0.5.0` will always mean the same snapshot.

### The life of a pull request

```
  1. branch off main          2. work, push, open a PR      3. squash-merge
                                                              (branch is deleted)
  main ──●──●                     you/fix-sidebar
            └──► you/fix-sidebar   ●──●──●──●  ──► PR ──►  main ──●──●──●──■
                                   wip  typo  …                       ▲
                                                                      │
                                              one commit on main, titled with
                                              the PR title: "fix(sidebar): …"
```

1. Branch from `main`: `<you>/<short-slug>`, or the name Linear's **copy git branch name** gives you.
2. Push and open a PR against `main`. Keep it to days, not weeks: a long-lived branch drifts away from everyone else's work.
3. When CI passes and it's reviewed, it is **squash-merged**: the whole PR becomes one commit on `main`, and GitHub deletes the branch.

**Squash-merging means the PR title is the commit message**, so the title follows [Conventional Commits](https://www.conventionalcommits.org/). The commits inside your branch can say anything, since they never reach `main`. A check on every PR holds the title to this shape:

```
  type(scope): what changed, in the present tense
  ────  ─────  ──────────────────────────────────
   │      │      └─ what a user or a teammate would notice
   │      └──────── optional: the area (chat, terminal, settings, …)
   └─────────────── feat · fix · perf · refactor · docs · style · test · build · ci · chore · revert
```

| Title                                                       | Shows up in the changelog as | Next version |
| ----------------------------------------------------------- | ---------------------------- | ------------ |
| `feat(chat): paste images into the composer`                | Features                     | minor bump   |
| `fix(terminal): keep the close button clickable`            | Fixes                        | patch bump   |
| `perf(timeline): virtualise long sessions`                  | Performance                  | patch bump   |
| `revert: …`                                                 | Reverts                      | patch bump   |
| `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore` | (not listed)                 | no bump      |

**`main` must stay shippable.** Anything merged can go out in the next release. Unfinished work either waits on its branch or lands switched off behind a setting until it's ready.

**Issues close themselves.** `main` is the default branch, so `Fixes #N` in the PR body closes the issue when the PR merges.

### How a release happens

Nobody bumps versions or writes the changelog by hand. A bot, [release-please](https://github.com/googleapis/release-please), reads the PR titles that land on `main` and keeps one pull request open called **`chore: release X.Y.Z`**:

```
  main ──■──────■──────■──────■──────────────────■───────────────────►
         │      │      │      │                  ▲
       feat:  fix:   fix:   feat:                │ merge the release PR
         │      │      │      │                  │
         ▼      ▼      ▼      ▼                  │
     ┌─────────────────────────────────────────┐ │
     │ PR: chore: release 0.6.0                │─┘
     │  • version → 0.6.0 in all four files    │
     │  • CHANGELOG.md: Features / Fixes       │       tag alpha-0.6.0
     │  updated on every merge to main         │ ───►  GitHub release
     └─────────────────────────────────────────┘       installers built and attached
```

1. Every merge to `main` updates the release PR: the next version number (from the titles, see the table above) and the changelog.
2. When you want to ship, review the release PR and merge it. That is the whole decision.
3. Merging it tags `alpha-X.Y.Z`, publishes the GitHub release with the changelog as its notes, and `.github/workflows/release.yml` builds the installers and attaches them.
4. One step is still by hand: point the PostHog remote-config keys at the new installers (see **Releasing** below). That is what makes installed apps offer the update, so it happens only after someone has tried the build.

**Every release gets a new number.** The auto-updater only offers a version strictly newer than the installed one, so two builds shipped as the same number can't update into each other.

### Semantic versioning

Atlas is pre-1.0, so the version is `0.MINOR.PATCH`:

```
  0 . 6 . 2
  │   │   └─ PATCH: a release with only fixes          0.6.1 → 0.6.2
  │   └───── MINOR: a release with any new feature     0.6.2 → 0.7.0
  └───────── stays 0 until 1.0
```

At 1.0 the first number starts meaning "breaking change", as in [semver](https://semver.org/).

### Hotfixes

Sometimes a shipped version needs a fix while `main` already holds work that isn't ready to ship. Then, and only then, a `release/X.Y` branch is made from that release's tag:

```
  main ──●──────●──────●──────●(fix)──────●──────►
         │                     │
    alpha-0.6.0                │ cherry-pick: copy just that one commit
         │                     ▼
         └──► release/0.6 ──────●──► tag alpha-0.6.1
```

1. Fix it on `main` first, as a normal PR.
2. `git checkout -b release/0.6 alpha-0.6.0`, then `git cherry-pick <the fix's commit>`. A cherry-pick copies one commit onto another branch.
3. `bun run bump 0.6.1`, commit, open a PR into `release/0.6` and merge it.
4. Tag that commit `alpha-0.6.1` and push the tag. A tag pushed by a person starts `release-linux.yml`, which builds Linux and creates the GitHub release; build macOS and Windows by hand (see **Releasing**).
5. Tell the release PR on `main` that 0.6.1 is taken: the next PR merged into `main` carries a line `Release-As: 0.6.2` (or `0.7.0`) in its description. Squash-merging keeps the description in the commit, and release-please reads it. Without this it would propose 0.6.1 again, and the updater ignores a number it has already seen.

The `release/X.Y` branch is never merged back. `main` already has the fix.

### What lives where

| Name                 | What it is                                         | Lives for              |
| -------------------- | -------------------------------------------------- | ---------------------- |
| `main`               | The trunk. Always builds, passes CI and could ship | forever                |
| `<you>/<short-slug>` | One issue's worth of work                          | days; deleted on merge |
| `release-please--…`  | The bot's release PR branch; don't push to it      | until the release      |
| `release/X.Y`        | Hotfixes for a shipped version only                | as long as needed      |
| `alpha-X.Y.Z` (tag)  | A release                                          | forever                |

## Releasing

`.github/workflows/release.yml` runs on every push to `main`. The release PR it keeps open is described above; merging it starts the builds:

```
  merge "chore: release 0.6.0"
              │
              ▼
  tag alpha-0.6.0 + GitHub release (notes = changelog)
              │
     ┌────────┼──────────────────────┬──────────────────────┐
     ▼        ▼                      ▼                      ▼
   Linux    macOS DMGs             Windows MSI             (by hand, after a try-out)
   always   when MACOS_RELEASE     when WINDOWS_RELEASE    PostHog remote config:
            = true                 = true                  version + installer URLs
```

- **Linux** (`release-linux.yml`): x86-64 and aarch64 on Ubuntu 22.04 (the glibc floor). It packages a tarball, AppImage, deb, rpm and, on x86-64, an Arch package. It then **verifies** them with `scripts/verify-linux-release.sh`: the binary loads within the floor, every package installs and starts on clean Debian, Ubuntu, Fedora and Arch containers, and the GUI comes up under Xvfb. Only then does it attest, sign and attach them. A pull request that touches a release input runs the same build and verification without publishing.
- **macOS**: `scripts/release-macos.sh` on a GitHub macOS runner, signed with the Developer ID certificate and notarized. It runs once the signing secrets are in the `release` environment and the repository variable `MACOS_RELEASE` is `true`. Until then, run the script on a Mac that holds the certificate and upload the DMGs to the release.
- **Windows**: the x64 MSI from `bun run build:app:win`, unsigned for now, once `WINDOWS_RELEASE` is `true`.
- Every build needs the `POSTHOG_KEY` secret. Without it the app has no telemetry key, and so no update checks.

Then, by hand, after trying the build: set the PostHog remote-config payloads `version`, `uri_mac_arm`, `uri_mac_intel`, `uri_win_intel` (direct installer URLs), and `uri_linux_x86_64` and `uri_linux_aarch64` (the release page). Run the by-hand matrix in `docs/qa/linux-smoke-matrix.md`. Supported distros, what each package needs and how signing works are in `docs/reference/linux-support.md`.

### Versioning

The version is written in four places: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the app's entry in `Cargo.lock` (left stale, CI's `--locked` builds refuse to run). Everything else reads it from one of those: Rust through `CARGO_PKG_VERSION`, the About screen through `getVersion()`, the DMG scripts from `tauri.conf.json`.

The release PR sets all four (release-please moves `package.json`, and the workflow runs `scripts/bump.sh` for the rest). Run the script yourself only for a hotfix:

```bash
bun run bump 0.6.1    # set every version file to 0.6.1
bun run bump          # or: patch bump from the current version
```

Never edit the four by hand.

## Verification

```bash
bun run lint                       # oxlint on src/, tests/, scripts/
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
- **Over a size cap**, only when `ATLAS_GC_MAX_MB` is set: it removes the
  least recently used artifacts until the dir fits. For a target dir shared
  by several worktrees, which churns through dependency versions faster than
  30 days can age them out. `ATLAS_GC_UNUSED_DAYS` and `ATLAS_GC_EVERY_DAYS`
  shorten the two windows above for the same case. The main checkout's
  `target/` sets none of them. A `target/` that is a symlink (the shared dir)
  is only collected by the worktree wrapper, under its build lock, since
  cargo-sweep takes no lock of its own.

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
  `node scripts/ci-affected.mjs --base origin/main`.

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
