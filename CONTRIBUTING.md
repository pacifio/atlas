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

For a new report, include your Atlas version (Settings → About), your macOS version, and which agent was selected.

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

## Requirements

**macOS is the supported platform.** Linux and Windows build from the same Tauri codebase but are untested, so expect to be the first person to hit whatever breaks. Reports from either are genuinely welcome.

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/), stable
- Xcode Command Line Tools
- The `claude` CLI on your `PATH`, only if you're working on the Claude Code agent. The native agent needs nothing extra.

## Local setup

```bash
bun install
bun run dev:app
```

The first Rust compile takes a few minutes. After that it's seconds.

**No API keys are needed to build or run Atlas.** `.env` is optional — copy `.env.example` only if you want to point telemetry at your own PostHog project. Left blank, telemetry is permanently inert.

```bash
bun run dev             # Vite only, no Tauri shell. Fast for pure UI work, but invoke() calls fail
bun run format          # Prettier on src/
```

Run `bun run lint` for the frontend ESLint checks. Use `bunx tsc --noEmit` as the TypeScript gate.

## Fork, branch, PR

Every change comes in through a fork and a pull request.

```bash
# 1. Fork pacifio/atlas on GitHub, then clone your fork
git clone git@github.com:<you>/atlas.git
cd atlas

# 2. Point `upstream` at the canonical repo
git remote add upstream git@github.com:pacifio/atlas.git
git fetch upstream

# 3. Find the current version branch — the highest-numbered one
git ls-remote --heads upstream \
  | sed 's|.*refs/heads/||' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1

# 4. Branch from it, not from main
git checkout -b <you>/atl-123-short-slug upstream/0.2.4

# 5. Push to your fork, then open the PR against that same version branch
git push -u origin <you>/atl-123-short-slug
```

Linear generates branch names in the form `<you>/atl-<id>-<slug>`. Use them as given.

To pick up changes made while you were working:

```bash
git fetch upstream
git rebase upstream/0.2.4
```

Leave **Allow edits from maintainers** checked when you open the PR. It lets small fixes land without another round trip.

## Branching model

Atlas uses version branches, not trunk-based development.

| Branch | Purpose | Merges into |
|---|---|---|
| `main` | Release branch | — |
| `0.2.4`, `0.2.5`, … | Integration branch for an upcoming release | `main`, and that merge is the release |
| `<you>/atl-<id>-<slug>` | One issue's worth of work | The current version branch |
| `feature-*`, `fix/*`, `mvc`, `ui` | Work spanning version cycles | `main` or the active version branch, depending on timing |

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
bunx tsc --noEmit                  # frontend typecheck
cd src-tauri && cargo check        # Rust typecheck, including every crates/* dependency
```

Rust tests run offline and need no API keys:

```bash
cd src-tauri && cargo test -p atlas-cersei                      # the native agent
cd src-tauri && cargo test -p atlas-cersei --test tools_eval    # a single file
cd src-tauri && cargo run -p atlas-acp --example smoke          # ACP transport smoke test
```

Run `cargo test -p <crate>` for any workspace crate you touched.

There's no frontend test runner. UI work is verified by running the app and using the feature in a window.

## Pull request checklist

- [ ] PR targets the current version branch, unless it's a small standalone fix
- [ ] `bunx tsc --noEmit` passes
- [ ] `cd src-tauri && cargo check` passes
- [ ] `cargo test -p <crate>` passes for every crate you touched
- [ ] You have run the app and used the feature in a window
- [ ] No commented-out code, no leftover `console.log`
- [ ] No new top-level dependencies unless discussed in the issue
- [ ] `TELEMETRY.md` updated, if you touched the telemetry pipeline

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
