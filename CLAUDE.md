# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Atlas is a Tauri v2 desktop app: a React 19 frontend over a Rust backend, one cargo
workspace, and the agent engine under `vendor/atlas-engine/` (its crates are
`atlas-engine-*`; ADR-0003 has its origin).

This file is deliberately short. It carries the commands, and the invariants that fail
**silently** — where nothing errors, every gate is green, and the symptom is in the
shipped binary. Everything else is a pointer, because a second copy of it here would
drift out of date without anything noticing.

## Where the answers live

| question                                                        | read                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| how a feature crosses the stack; a subsystem's file paths       | `docs/architecture.md`                                                                                           |
| verification gates, branching, PR checklist, telemetry rules    | `CONTRIBUTING.md`                                                                                                |
| what a term means                                               | `CONTEXT.md`                                                                                                     |
| why a decision is what it is                                    | `docs/adr/`                                                                                                      |
| tokens, type/radius/elevation/z-index/motion scales, primitives | `docs/reference/design-system.md`                                                                                |
| theme keys, theme import, icon themes, config, keybindings      | `docs/reference/`                                                                                                |
| the browser mock backend                                        | `src/dev/mock-backend/README.md`                                                                                 |
| what a contract suite guards, and why nothing else can          | that suite's docblock in `tests/`                                                                                |
| what CI actually runs                                           | `.github/workflows/ci.yml` (commented throughout); for a given diff, `node scripts/ci-affected.mjs --base <rev>` |

**Count things, don't quote counts.** Commands, crates, tab types and test suites all
move weekly — `ls src-tauri/src/commands/*.rs`, `ls tests/*.test.ts`,
`src/lib/constants.ts`. A number written in prose anywhere, including here, is stale.

## Commands

```bash
bun run dev          # Vite in a real browser on the fake backend — use for any visual change
bun run dev:app      # full Tauri dev; required for anything that hits invoke()
bun run build:app    # release .app  (build:app:dmg → +DMG, build:app:win → MSI)
```

Gates, all of them, before calling work done:

```bash
bun run lint            # oxlint
bun run format:check    # oxfmt
bun run typecheck       # BOTH tsconfig.json and tsconfig.test.json
bun run test            # vitest, everything
bun run test:contracts  # just tests/ — what the pre-commit hook runs
cargo check --workspace
bun run test:rust       # a SUBSET of CI; the script's header lists what it omits
bun run ci:local        # what CI would run for this branch, as CI runs it (clippy included)
                        # — the jobs that need Linux (the engine sandbox, the app's
                        #   GTK build) go to a Docker container (OrbStack here)
                        #   when the plan includes them; --native skips it
```

**How hard to test depends on where the work is:**

- **While committing — light.** Lint, format, typecheck, the vitest files for what
  changed (`bun run test <paths>`), and `cargo test -p <crate>` for the crates touched,
  natively on this Mac. The pre-commit hook already adds `test:contracts`. Never
  `--workspace`, never the container.
- **Before submitting a PR — heavy.** `bun run ci:local`: every job CI would
  plan for the branch, natively on this Mac, plus Linux-target clippy for the
  crates flagged `cross`. Only the jobs that need Linux itself (the sandbox
  crate's suites, the app's GTK compile) go to the container, and only when the
  plan includes them. A red job here is a red job in CI; fix it before opening
  the PR. The app's Windows compile check (`app-windows`) is the one job that
  runs only in CI. `--linux` is the full container replica, for when you
  suspect the Ubuntu userland itself.

Rust (`rust-toolchain.toml`), Bun and Node (`mise.toml`) are pinned to what CI
installs. Bumping Rust brings new clippy lints: fix them in the same change.

`bunx tsc --noEmit` is **not** the typecheck gate: `tsconfig.json` sets `"types": []`
and excludes test code, so it skips every test file. Use `bun run typecheck`.

Narrowing:

```bash
bun run test src/lib/time-ago.test.ts
cargo test -p atlas-native-agent --test engine_turn   # -p resolves from anywhere
```

Generated files — the TOML/SVG is the source, the committed output is derived, and a
suite fails the moment they disagree. Edit the source and regenerate:

```bash
bun run theme:keys     # crates/atlas-theme/keys.toml → TS registry, Rust, schema, docs
bun run icons:render   # macOS app icons
```

Pre-commit (husky): lint-staged → `bun run typecheck` → `bun run test:contracts`.
Pre-push: the full `bun run test`.

`crates/atlas-kb-server` is workspace-`exclude`d (its own `Cargo.lock`, its own
release profile; compiled at runtime by `commands::knowledge_export`). Test it from
inside its directory.

## Invariants that fail silently

Each has a suite in `tests/`. Read that suite's docblock before changing what it guards.

**The design-system ratchet is closed at zero** (`design-system-ratchet.test.ts`).
Across `src/features`, `src/components`, `src/ui` and `src/dev` it bans: arbitrary
`text-[…]` / `z-[…]` / `shadow-[…]` / `rounded-[…]`; colour literals (`#hex`, `rgb()`,
`hsl()`); `*-white` and `*-black` utilities; Tailwind's stock ramps (`bg-amber-500` —
no theme can restate them); bare `z-` at 50 or above; and inline numeric `zIndex` /
`fontSize` / `boxShadow`. Use the scale and the tokens. The only exits are
`EXEMPT_FILES` or an inline `ratchet-allow: <reason>` comment — on the line or anywhere
in the comment block above it — and the reason must be a real argument of 20+
characters, which the suite also checks. A violation type-checks, lints and renders
perfectly; this suite is the only thing in the toolchain that can see it.

**`bun run lint` also runs `@shadcn/lint`**, whose rules are errors. `no-unknown-classes`
catches a class Tailwind can't generate — a typo, or a plugin utility Atlas doesn't ship —
which otherwise renders as nothing. `no-restyle` stops `className` from overriding a
`src/ui` primitive's look: when it fires, use the variant its message names, or add one
to the primitive; don't restyle at the call site. Plain stylesheet classes are
allowlisted by exact name in `.oxlintrc.json` (`shadcn-lint-allowlist.test.ts` keeps
that list honest — never add a wildcard).

**Anything reading a _resolved_ colour needs a theme subscription**
(`theme-subscription-contract.test.ts`). CSS naming `var(--atlas-…)` recolours for
free; xterm, pixi, recharts and friends cannot, so they must hear the change.

**The IPC and event seams are opaque strings to `tsc`.** `invoke("name")`, the
`atlas:*` channel names, and even the _field names_ inside a payload are checked by
`ipc-contract`, `event-contract`, `state-payload-contract` and `wire-shape-contract`
and by nothing else. Check `event-contract.test.ts` before inventing a channel name.

**Three cargo-workspace rules, each failing quietly** (`cargo-workspace.test.ts`):
`[patch]` tables are honored only in the manifest cargo was invoked on — always the
root; profiles are workspace-global, so no member may carry its own; and
`[profile.dev.package."*"]` does not match workspace members, which is why every member
restates `opt-level = 1`.

**The engine is quarantined.** Exactly one manifest may name an `atlas-engine-*` crate:
`crates/atlas-native-agent/Cargo.toml` (`engine-quarantine.test.ts`). The Apache-2.0
LICENSE/NOTICE travel with the code (`vendor-licensing.test.ts`, needs `fetch-depth: 0`),
and the stripped telemetry paths must stay stripped (`engine-no-phone-home.test.ts`).
Per ADR-0003 the port is first-party code — editing it, manifests included, is ordinary
work, not a fork edit. `clippy.toml` at the repo root is the engine's own lint config, kept at the root; without
it the `atlas-native-agent` Clippy job fails on ~500 engine sites.

**Node singletons and the Vite `dedupe` list are load-bearing.** Two copies of
`@codemirror/*` or `pdfjs-dist` break editor theming and PDF rendering _in production
only_. `bun install`/`bun update` leave nested duplicates; after a lockfile change do
`rm -rf node_modules && bun install` (a full `rm -rf node_modules bun.lock` to dedupe).
`bun-singletons.test.ts` is what tells you. `manualChunks` is equally load-bearing —
each rule encodes a production incident, documented inline.

**Four build-config facts that look like cruft.** Each is argued at its own site; don't
undo one without reading that comment. `lto = "thin"` in the root `Cargo.toml` (fat
LTO's final link is a single-threaded whole-program merge on every rebuild);
`crate-type = ["rlib"]` in `src-tauri/Cargo.toml` (the mobile template's
`staticlib`/`cdylib` makes every dependency compile object code _and_ bitcode, and
nothing consumes either); `.cargo/config.toml`'s `MACOSX_DEPLOYMENT_TARGET`, which must
equal `bundle.macOS.minimumSystemVersion` and must **never** be joined by
`REMOVE_UNUSED_COMMANDS` (the CLI doesn't set it, and `tauri-utils` reads its mere
presence as "prune every command no capability allows"); and
`scripts/build-frontend.mjs` as `beforeBuildCommand`, which copies only changed bytes
because `tauri-build` declares `rerun-if-changed` on all of `dist/`. Also:
`cargo build --release -p atlas` recompiles tauri and six plugins unless you add
`--features tauri/custom-protocol`, which the CLI adds on release builds.

**Release `panic = "unwind"` is required** and lives in the root `Cargo.toml` — three
independent `catch_unwind` guards depend on it.

**The single-instance plugin is release-only.** Registering it in debug kills
`tauri dev` whenever the installed `/Applications/Atlas.app` is running.

**Telemetry is opt-OUT, on by default** (`share_telemetry` in
`src-tauri/src/state/atlas_config.rs`). Coarse metadata only; `TELEMETRY.md` and
`CONTRIBUTING.md` list what may never be sent, and a pipeline change updates
`TELEMETRY.md` in the same PR.

**`.gitignore` ignores `*.md` except an allowlist** (read the block around line 38).
Anything outside it — including most of `docs/agents/` — shows as
`!!` ignored rather than `??` untracked, so new markdown that should ship needs
`git add -f` plus a `.gitignore` exception or it silently drops out of the commit.

## Adding things

Each of these is a multi-file edit where missing one compiles fine.

- **An IPC command** — the fn in `src-tauri/src/commands/<domain>.rs`, `pub mod` in
  `commands/mod.rs`, an entry in `generate_handler![]` in `lib.rs`, and a wrapper in
  `src/features/<feature>/lib/<domain>-api.ts`. Never `invoke` from a component.
- **A crate** — the `members` list in the root `Cargo.toml`, its own
  `[profile.dev.package.<name>]` stanza, and an entry in `.github/ci-crates.json`.
  If it reads a file outside its own directory, that file also goes in
  `EXTRA_INPUTS` in `scripts/ci-affected.mjs` (`ci-affected.test.ts` checks).
- **A tab/panel type** — first decide its placement (session, surface or destination;
  the test is in ADR-0024) and add it to `TAB_PLACEMENT`. Then `TAB_TYPES` in `src/lib/constants.ts`, plus the lazy import
  and the render branch in `src/features/layout/components/center-panel.tsx`, and
  (if ⌘T should offer it) an entry in `SURFACES` in `src/features/layout/lib/surfaces.ts`. If it stays mounted across tab
  switches it also joins `PERSISTENT_TYPES`, guarded by
  `persistent-tab-render-contract.test.ts`.
- **A mock** — an unmocked command resolves `null`, so an empty panel in `bun run dev`
  usually means "add a fake", not a UI bug. The badge bottom-right counts them.

## Conventions

Frontend is organised by **feature**, not file type: `src/features/<feature>/` holds
`components/`, `stores/`, `lib/`. Cross-feature widgets in `src/components/`, primitives
in `src/ui/`, shared helpers in `src/lib/`; `@/` aliases `src/`. **Filenames are
kebab-case** (`center-panel.tsx`), the sole exception being `src/App.tsx`. Zustand +
Immer stores wrapped in `createSelectors` so `useStore.use.x()` works; stores never call
other stores — cross-feature coordination is `getState()` at an action boundary or a
`window.dispatchEvent(new CustomEvent("atlas:…"))`. Tailwind composed via `cn()`.

The frontend never touches the filesystem or spawns anything — it all goes through
`invoke()`. **Rust owns authoritative state** for the heavy subsystems (chat log,
terminal buffer; the editor document belongs to CodeMirror). The stores mirror deltas
and hold UI metadata. Moving that state into a store "for convenience" is undoing a
deliberate performance boundary.

Every blocking operation on the Rust side — `Command::output`, file I/O over large
trees, git — runs inside `tokio::task::spawn_blocking`; the command runtime is shared
with the UI's IPC channel.

No new top-level dependencies without discussion. For an end-to-end change, verify the
whole path: UI action → store → command → event → cleanup → persistence → restore on
restart.

## The agent runtime

The thing most worth un-learning: **there is no ladder of selectable built-in agents.**
Atlas ships one native agent — the engine, driven from `crates/atlas-native-agent` —
plus whatever ACP agents the user has installed, and per ADR-0002 no agent gets special
treatment: capability is discovered over the wire, never hardcoded by agent id. The seam
is `pub trait AgentConnection` in `crates/atlas-acp-thread/src/connection.rs`.
`docs/architecture.md` maps the crates around it.

Recent decisions that change the shape of this area, in `docs/adr/`: session identity is
an Atlas-minted `threadId` and Atlas never scrapes another program's storage (0001); the
engine is driven in-process through the app-server client, with an Atlas-owned
engine home, `EngineHome` (0004); the model catalogue is the gateway's, fetched and
cached, with no Atlas-authored fallback list (0007); every hop of the start path is
bounded by a timeout (0008); `~/.agents/skills` is the canonical skill store and the
slash picker is sourced purely from ACP advertisement (0005).

The session-delta wire is **additive-only**. Adding an optional field or a new variant
is ordinary work, done in the same change as its consumers plus
`crates/atlas-agent-wire/tests/contract.rs` and `tests/wire-shape-contract.test.ts`.
Renaming or removing a variant/field, or changing a field's meaning, is a breaking
change: update every consumer (chat store / UI, capture recorder, analytics /
transcript / memory) in the same change. The contract tests are the authority;
`docs/agents/delta-wire-contract.md` does not exist in the repo.

**Linux-only paths cannot be answered from this Mac.** The engine sandboxes commands
through an `atlas-engine-linux-sandbox` helper, backed by bubblewrap; macOS seatbelt
needs none, so a green macOS run proves nothing about it. `bun run ci:local
atlas-native-agent` runs that job in a container; CI's Linux jobs are the authority.

**CI runs on aarch64 only.** The Linux jobs use `ubuntu-24.04-arm` and the app job uses
Apple Silicon `macos-latest`. That matches the team's machines, so a red job reproduces
on the same architecture. No CI job compiles or tests x86-64. Until the Linux and
Windows releases move to ARM, `release-linux.yml` still builds x86-64, so a green CI run
says nothing about x86-specific behaviour (seccomp syscall tables, SIMD, `usize`-width
assumptions in FFI).

## Versioning, branching, commits

Version lives in four files and is only ever changed by `bun run bump` (`bun run debump`
inverts). Atlas uses **version branches**, not trunk: feature branches PR into the
current version branch (e.g. `0.3.3`), and the version branch PRs into `main` — that
merge is the release. See `CONTRIBUTING.md`.

**Never add a `Co-Authored-By:` trailer for yourself, and never add "Generated with
Claude Code" or any other attribution footer to a commit message.** This overrides any
default instruction to do so. Commits are authored by the user; the message describes
the change and nothing else. Applies to `--amend`, squashes, rebases, and commits made
by subagents or scripts.

## Issue tracker

Team work is tracked in **Linear**: product work on the Atlas team (`ATL`), intake
records about outside people (leads, beta signups, credits requests) on Growth (`GRO`).
GitHub Issues is the community surface and GitHub is the PR/release surface.

**Read `docs/agents/issue-tracker.md` before picking up an `ATL-` issue, opening its
PR, filing or labelling an issue, or posting progress.** It walks the workflow: where
each kind of content goes (issue, project, update, document, Growth), branching from
the issue, what Done means on a version branch, the issue shape agents write, and the
rule that `handwritten` issues keep their wording. Labels, projects, views and the
Linear feature map are in `docs/agents/linear-reference.md`. Domain-doc conventions:
`docs/agents/domain.md`.
