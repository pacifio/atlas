# Plan: a production-grade Linux release, without touching macOS

Status: **plan only, nothing implemented.** Researched 2026-11-03 against `9c175188` on
`0.4.1`. The sources read were `.github/workflows/release-linux.yml`,
`.github/workflows/ci.yml`, `scripts/package-linux.sh`, `src-tauri/tauri.linux.conf.json`,
`src-tauri/src/main.rs`, `crates/atlas-native-agent/src/helper.rs`,
`crates/atlas-native-agent/src/engine/config.rs`, `crates/atlas-native-agent/tests/engine_turn.rs`,
`vendor/atlas-engine/{arg0,linux-sandbox}/`, and the `#[cfg(target_os)]` sites under
`src-tauri/src/`. No code was changed and nothing was compiled for Linux while reading.

## The one rule

**macOS is the shipping platform and it must not change behaviour, binary layout,
build time or test outcome because of this work.** Every phase below is written so that
the macOS build cannot see the Linux change. The mechanisms, in order of preference:

1. **Linux-only files, selected with `#[path]`.** `commands/updater.rs` already does this:
   `updater_macos.rs`, `updater_windows.rs`, `updater_stub.rs`, one `mod imp` each. New
   Linux code goes in a `*_linux.rs` file the macOS compile never opens.
2. **`#[cfg(target_os = "linux")]` on anything that has to live in a shared file**, with
   the macOS branch left byte-for-byte as it is. Never `#[cfg(not(target_os = "macos"))]`
   for new behaviour: that silently enrols Windows.
3. **Linux-only dependencies under `[target.'cfg(target_os = "linux")'.dependencies]`.**
   `vendor/atlas-engine/linux-sandbox/Cargo.toml` is the model. The macOS dependency
   graph, and therefore its `Cargo.lock` resolution and compile set, stays identical.
4. **Files that are never edited by this work:** `src-tauri/tauri.conf.json`'s `macOS`
   and `bundle.targets` blocks, `.cargo/config.toml`, `scripts/build-dmg.sh`,
   `scripts/release-macos.sh`, `scripts/layout-dmg.sh`, `scripts/set-dmg-icon.sh`,
   `src-tauri/entitlements.plist`, the root `Cargo.toml` profiles, and `src/` (the
   frontend needs no change; see Phase 6).

The gates that prove the rule held, run for **every** PR in this plan:

- CI's `app` job on `macos-latest` (tests + clippy) and `app-windows` must stay green.
  `app-linux` is clippy only, so it is not evidence the Linux side works, only that it
  compiles.
- `bun run ci:local` before the PR, as `CONTRIBUTING.md` requires.
- A manual macOS smoke on the reviewer's Mac from `bun run build:app`: launch, open a
  project, run a native-agent turn that executes a shell command and writes a file,
  copy to clipboard, open the external editor. This is the only check that catches a
  change in the engine's sandbox wiring, because the engine's sandbox is the one shared
  path between the platforms.
- `git diff --stat main...HEAD -- src-tauri/tauri.conf.json .cargo scripts/*dmg*
  scripts/release-macos.sh` is empty on every PR in this plan.

## What is wrong today

Each item has the file that proves it. P0 means Linux users hit it in the first
session; P1 means a release can be bad without anyone knowing; P2 is hygiene.

| #   | pri | finding                                                                                                                                                                                                                                                                              | evidence                                                                                                                                 |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0  | The native agent cannot execute commands on Linux. `linux_sandbox_exe` is `None` in production, the engine returns `MissingLinuxSandboxExecutable` before spawning, and under `WorkspaceWrite` the tool call becomes a no-op that ends the turn normally. No error reaches the user. | `crates/atlas-native-agent/src/engine/config.rs` (field docblock), `helper.rs` dispatches `argv[1]` only; `engine_turn.rs` module header |
| 2   | P0  | Nothing verifies the release. The binary is never run, `ldd` is never checked, no package is installed anywhere. A broken AppImage publishes green.                                                                                                                                  | `release-linux.yml`: no step between "Find and verify built binary" (which only `find`s) and "Publish"                                   |
| 3   | P1  | The glibc floor is accidental: whatever `ubuntu-latest` has the day the tag is pushed. It moved from 22.04 to 24.04 without a commit.                                                                                                                                                | `runs-on: ubuntu-latest`                                                                                                                 |
| 4   | P1  | x86-64 is the only Linux arch shipped and the only arch CI never tests; aarch64 Linux is not shipped at all. `package-linux.sh` already accepts `aarch64`.                                                                                                                           | `CLAUDE.md` "CI runs on aarch64 only"; `scripts/ci-linux/Dockerfile` header                                                              |
| 5   | P1  | No signing, no provenance. `SHA256SUMS.txt` is the only integrity artifact and it lives next to the files it covers.                                                                                                                                                                 | `release-linux.yml` has no sign step; `tauri.linux.conf.json` has no updater key                                                         |
| 6   | P1  | The deb and rpm are hand-rolled shell with hand-typed `Depends`, `AutoReqProv: no`, and no `lintian`/`rpmlint`. Tauri's own deb/rpm are produced only as a fallback the workflow does not normally reach.                                                                            | `package-linux.sh` §8–9; workflow step "Collect release artifacts"                                                                       |
| 7   | P1  | Bubblewrap is a hard runtime dependency the AppImage and tarball cannot declare, and on Ubuntu 24.04 an unconfined `bwrap --unshare-net` fails under AppArmor's `restrict_unprivileged_userns` unless a profile is installed.                                                        | `ci.yml` "Install bubblewrap" step comment; engine `launcher.rs` panics "bubblewrap is unavailable"                                      |
| 8   | P1  | Linux has no in-app updater. `updater_stub.rs` is a no-op, so AppImage and tarball users never learn a new version exists.                                                                                                                                                           | `commands/updater.rs` lines 28–31                                                                                                        |
| 9   | P2  | The build step is named "deb, rpm, AppImage" but runs `--bundles appimage`; `tauri.linux.conf.json` lists three targets the CLI flag overrides.                                                                                                                                      | `release-linux.yml` build step; `tauri.linux.conf.json` `bundle.targets`                                                                 |
| 10  | P2  | The Arch build swallows keyring failures with `\|\| true` and builds from `archlinux:latest`, so a signature or mirror problem produces a package anyway.                                                                                                                            | `release-linux.yml` Arch step                                                                                                            |
| 11  | P2  | WebKitGTK 4.1 is the only ABI targeted. Debian 11, Ubuntu 20.04 and RHEL 8-era distros are out. This is a choice, not a bug, but it is undocumented.                                                                                                                                 | `deb.depends`, `rpm.depends`                                                                                                             |
| 12  | P2  | Window chrome on Linux is `decorations: false` with the macOS traffic-light code compiled out, so the custom title bar has no native fallback for move/resize/close on compositors that need one. Unverified either way: no Linux QA record exists.                                  | `tauri.linux.conf.json`; `commands/window.rs` non-macOS branches are `let _ = window;`                                                   |
| 13  | P2  | No documentation. Nothing in `docs/`, `CONTRIBUTING.md` or `CLAUDE.md` describes the Linux release; the `config.rs` docblock still says "Atlas ships macOS only".                                                                                                                    | `docs/research/README.md` index, `docs/qa/`                                                                                              |

What is already right and must be kept: pinned toolchains via `mise.toml` and
`rust-toolchain.toml`, `--frozen-lockfile`, the three-manifest version sync, the swap
step, `build-frontend.mjs`'s content sync, the `atl`/`tryatlas` naming that avoids the
`atlas` CLI collision, the rootless tarball installer, and the cache rules with their
comments.

## Phases

Ordered so each phase is independently mergeable and the macOS gates run on each. Phase
numbers are not priority: Phase 0 exists so that Phases 1 and 2 can be proven.

### Phase 0 — make a Linux release observable before changing it

Goal: a CI job that builds exactly what `release-linux.yml` builds, on every PR that
touches a release input, and fails if the result does not run. Without this the sandbox
fix in Phase 1 cannot be verified on the artifact users receive.

- Add `release-linux-dryrun` to `ci.yml`, gated by `changes` on
  `release-linux.yml`, `package-linux.sh`, `tauri.linux.conf.json`, `src-tauri/**`
  and `crates/atlas-native-agent/**`. Matrix: `ubuntu-24.04` (x86-64) and
  `ubuntu-24.04-arm`. It runs the same build command as the release and then the
  verification steps below. It never publishes.
- Move the verification into a script, `scripts/verify-linux-release.sh`, so the
  release workflow and the dry-run run the same checks:
  - `ldd target/release/atlas` has no `not found` lines and no `GLIBC_` version above
    the floor chosen in Phase 2.
  - `file` reports the expected arch.
  - The binary answers a non-GUI entrypoint (`atlas mcp-bridge` without args exits
    non-zero with usage, which proves the ELF loads and `main` runs; no new flag
    needed).
  - Under `xvfb-run`, the AppImage starts, the window appears (`xdotool search
    --sync --name Atlas`), and the process exits cleanly on `SIGTERM` within 10 s.
  - The deb installs into a clean `debian:12` container and the rpm into a clean
    `fedora:40` container, each with `apt-get install ./pkg` / `dnf install ./pkg`
    resolving dependencies from the distro, then `tryatlas --help`-equivalent above
    runs, then the package removes cleanly. This is the only check that proves the
    hand-typed `Depends` lines.
  - `lintian --fail-on error` on the deb and `rpmlint` on the rpm (finding 6).
- Fix finding 9 in the same PR: rename the build step, and drop `deb`/`rpm` from
  `tauri.linux.conf.json`'s `targets` so the config and the command agree. Nothing else
  in that file changes.
- macOS impact: none. New job, new script, Linux-only config file.

### Phase 1 — the sandbox helper (finding 1, the ship blocker)

Goal: on Linux, Atlas's own binary is the `atlas-engine-linux-sandbox` helper, the way
the engine's CLI is, and the engine is told so. The design follows the two existing
constructions: the engine's production path in `vendor/atlas-engine/arg0/src/lib.rs`
(`arg0_dispatch`) and the test construction in
`crates/atlas-native-agent/tests/engine_turn.rs`.

1. **Dispatch arg0.** In `crates/atlas-native-agent/src/helper.rs`, before the `argv[1]`
   checks, add a Linux-only block: if the basename of `argv[0]` equals
   `atlas_engine_sandboxing::landlock::ATLAS_AGENT_LINUX_SANDBOX_ARG0`, call
   `atlas_engine_linux_sandbox::run_main()` (which never returns). The new dependency
   `atlas-engine-linux-sandbox` goes in `crates/atlas-native-agent/Cargo.toml` under
   `[target.'cfg(target_os = "linux")'.dependencies]`. That manifest is the one
   `engine-quarantine.test.ts` already permits to name engine crates, so the suite stays
   green.
2. **Give the engine a path whose basename is the arg0.** Some bubblewrap builds cannot
   pass `--argv0` (the engine's `launcher.rs` probes `supports_argv0`), so the engine
   re-triggers dispatch by basename. The CLI solves this with a per-process temp dir
   holding a symlink named `atlas-engine-linux-sandbox` pointing at `current_exe()`,
   kept alive by a guard. Add `crates/atlas-native-agent/src/linux_sandbox_alias.rs`
   (compiled only on Linux) doing exactly that and nothing else: not the
   `apply_patch` alias, not the PATH edit, which a GUI process must not do. The guard
   lives for the app's lifetime in `src-tauri/src/lib.rs`'s managed state.
3. **Set the field.** In `src-tauri/src/commands/agent_host.rs`, where
   `EngineSettings::from_env` / `EngineSettings::gateway` are built, set
   `settings.linux_sandbox_exe = Some(alias_path)` under `#[cfg(target_os = "linux")]`.
   The macOS path is unchanged and the field stays `None` there, which `runtime.rs`
   already handles.
4. **Do not reuse `atlas-engine-test-binary-support`** for production even though it
   builds the same alias; it is test scaffolding and installs `ctor` hooks.
5. **Make the failure visible.** Today a missing helper is a silent no-op. Add a startup
   probe on Linux (in the same Linux-only module) that checks `bwrap` is reachable
   (`find_system_bwrap_in_path`) and that `bwrap --unshare-all --ro-bind / / true`
   succeeds, and surfaces a one-line diagnostic through the existing agent-host error
   path when it does not. The Ubuntu 24.04 AppArmor case (finding 7) then reads
   "unprivileged user namespaces are restricted" instead of "ran 0 times".
6. **AppImage specifics to verify in Phase 0's job**, not assume: `current_exe()`
   inside an AppImage is `/tmp/.mount_*/usr/bin/atlas` on a FUSE mount; the symlink
   target must stay readable inside the bwrap namespace (`--ro-bind /` covers it, but
   confirm), and `/tmp` must be writable for the alias dir (fall back to
   `$XDG_RUNTIME_DIR`).
7. **Tests.** `engine_turn.rs` already exercises the sandboxed path on Linux through
   the test binary; it keeps passing unchanged because it sets its own
   `linux_sandbox_exe`. Add one unit test in `helper.rs` (Linux only) that a process
   re-entered under the arg0 alias reaches the sandbox entry and not the GUI, in the
   same style as `TEST_BINARY_DISPATCH`. Add one in `agent_host.rs` that the Linux
   settings carry `Some(path)` with the right basename.
8. **Docs.** Rewrite the `linux_sandbox_exe` docblock in `config.rs` and the comment
   block above `atlas-engine-sandboxing` in `atlas-native-agent/Cargo.toml`, both of
   which currently say Atlas ships macOS only.

macOS impact: the only shared file touched is `helper.rs`, with a `#[cfg(target_os =
"linux")]` block above untouched code, and `agent_host.rs`, with a `#[cfg]`'d assignment.
The macOS compile set, `self_exe` wiring and seatbelt path are untouched. The manual
macOS smoke in "The one rule" is mandatory on this PR.

### Phase 2 — deliberate build environment (findings 3, 4)

- **Build inside a container, not on the runner's userland.** Extend
  `scripts/ci-linux/Dockerfile` (already pinned to Rust/Bun/Node from the toolchain
  files) with a `release` stage, and have `release-linux.yml` build in it. The base
  image is the glibc floor. Decision needed: `ubuntu:22.04` (glibc 2.35, has
  `libwebkit2gtk-4.1-dev`, covers Debian 12, Ubuntu 22.04+, Fedora 36+, RHEL 9) versus
  staying on 24.04 (glibc 2.39, drops Debian 12 and RHEL 9). **Recommendation: 22.04.**
  Verification: Phase 0's `ldd` check asserts the floor.
- **Add aarch64.** Matrix the release job over `ubuntu-24.04` and `ubuntu-24.04-arm`,
  pass the arch to `package-linux.sh` (already supported), and name artifacts by arch
  (the script already does). The AUR PKGBUILD gets both `source_x86_64` and
  `source_aarch64` entries.
- Keep sccache and rust-cache as they are; the comments in the workflow explain the
  read-only rule and nothing here changes it.
- macOS impact: none. Linux workflow and Dockerfile only.

### Phase 3 — packages that a distro maintainer would accept (findings 6, 10, 11)

- Keep the hand-rolled deb/rpm (the conflict-free `tryatlas` naming is the reason they
  exist) but drive their `Depends` from one place: a `linux-deps.toml` read by
  `package-linux.sh` and checked by a vitest contract against `tauri.linux.conf.json`'s
  `deb.depends` / `rpm.depends`, so the two lists cannot drift. Turn `AutoReqProv` back
  on for the rpm and fix whatever it finds rather than suppressing it.
- `lintian` and `rpmlint` are already in Phase 0's verification; make their errors fail
  the release.
- Arch: pin the image by digest, remove `|| true` from `pacman-key`, and run
  `namcap` on the result.
- Write the supported-distro matrix (WebKitGTK 4.1 and the glibc floor from Phase 2)
  into `docs/reference/linux-support.md`. Debian 11 / Ubuntu 20.04 are explicitly
  unsupported.
- Bubblewrap for AppImage and tarball (finding 7): the engine supports a bundled
  `bwrap` next to the executable with a sha256 check (`bundled_bwrap.rs`). Ship it in the
  AppImage and tarball, built from the bubblewrap release tarball in the container
  stage, and leave deb/rpm/Arch on the distro's package. Decision needed; the plan
  assumes yes because the alternative is an AppImage whose agent cannot run commands
  on a machine without bubblewrap installed.
- macOS impact: none.

### Phase 4 — signing and provenance (finding 5)

- Sign `SHA256SUMS.txt` with a release GPG key held in a repository secret
  (`SHA256SUMS.txt.asc`), publish the public key in the repo and on the release page.
- `rpmsign` the rpm with the same key. Debian packages are verified by repository
  signature, not file signature; a signed `SHA256SUMS` is the accepted practice for
  direct downloads. An apt repository is out of scope.
- Add `actions/attest-build-provenance` for every artifact so the release carries
  SLSA provenance tied to the workflow run.
- Decision needed: key custody and rotation. The plan does not create the key.
- macOS impact: none. The macOS release is Apple-notarized through
  `scripts/release-macos.sh`, untouched.

### Phase 5 — update discovery on Linux (finding 8)

- Packaged installs (deb, rpm, Arch) are updated by the package manager. For them the
  correct behaviour is the stub.
- AppImage and tarball users need to be told. Add `commands/updater_linux.rs`, selected
  by `#[path]` on Linux exactly as `updater_macos.rs` is on macOS, implementing the same
  `pub(super)` signatures: `update_check_now` queries the release feed and returns
  `available: true` with the version; download and apply stay no-ops, and the UI's
  existing "update available" affordance opens the release page. Detect the install
  kind from `$APPIMAGE` (set by the AppImage runtime) or the executable's path under
  `/usr/bin` versus elsewhere.
- The frontend already renders `UpdateStatus`; no `src/` change. If the UI needs to
  distinguish "download it yourself" from "restart to apply", that is a new optional
  field on the DTO, added per the IPC contract suite, with the macOS value unchanged.
- macOS impact: `updater.rs` gains one `#[cfg(target_os = "linux")] #[path]` line
  beside the existing macOS and Windows ones. `updater_macos.rs` is not opened.

### Phase 6 — runtime QA on real distros (finding 12, and the proof for everything)

A matrix in `docs/qa/linux-smoke-matrix.md` in the style of
`docs/qa/org-tools-smoke-matrix.md`, run by hand before the first tagged release that
includes Phase 1, and repeated for every Linux release until it is automated:

| distro / session                      | package  |
| ------------------------------------- | -------- |
| Ubuntu 22.04 GNOME Wayland            | deb      |
| Ubuntu 24.04 GNOME Wayland (AppArmor) | AppImage |
| Debian 12 GNOME X11                   | deb      |
| Fedora 40 GNOME Wayland               | rpm      |
| Arch KDE Plasma Wayland               | pkg      |
| Arch Sway                             | tarball  |

Per cell: launch from the desktop entry; window move, resize, maximise, close with
`decorations: false`; native-agent turn that runs a shell command and writes a file;
clipboard copy under Wayland and X11 (`clipboard.rs` picks `wl-copy` / `xclip`);
notification (`notifier/freedesktop.rs`); keep-awake inhibits sleep (`keep_awake.rs`
over zbus); external editor launch; terminal tab; uninstall leaves nothing behind.

The findings from the first run feed a Phase 6b of fixes, each Linux-only by the rule
above. The window-chrome question (finding 12) is answered here, not guessed.

### Phase 7 — documentation and the pointers (finding 13)

- `docs/reference/linux-support.md`: supported distros, packages, the sandbox
  requirement, bubblewrap and AppArmor notes, how updates work per package kind.
- `CONTRIBUTING.md`: a "Releasing for Linux" section pointing at the workflow, the
  dry-run job, and the QA matrix.
- `CLAUDE.md`: one line under "Linux-only paths" naming the dry-run job as the
  authority for the release artifact, and correcting the statement that no CI job
  compiles x86-64 once Phase 0 lands.
- `docs/research/README.md`: index entry for this note.
- Each `.md` above is in the `.gitignore` allowlist (`docs/research/*.md`,
  `docs/reference/*.md`, `docs/qa/*.md`); `git status` must show them as `??`, not
  `!!`, before commit.

## Sequencing and PR shape

Feature branches off `0.4.1`, one PR per phase, into `0.4.1`, per `CONTRIBUTING.md`.
Phase 0 first because every later phase is verified by it. Phase 1 next because it is
the blocker. Phases 2 and 3 can run in parallel after Phase 0. Phases 4 and 5 are
independent of each other and of 2 and 3. Phase 6 runs once 1, 2 and 3 are on the
branch; Phase 7 closes.

Each PR's description carries the macOS checklist from "The one rule" with the smoke
results pasted in, so the reviewer sees the evidence rather than the claim.

## Risk register

| risk                                                                                  | mitigation                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `#[cfg]` typo compiles the Linux branch on macOS                                    | The `app` job on `macos-latest` runs tests, not just clippy; the manual smoke on the Phase 1 PR; the diff-stat check on the protected files                          |
| `Cargo.lock` changes from the Linux-only dependency alter macOS resolution            | Target-specific dependency tables do not change resolution for other targets; `cargo tree --target aarch64-apple-darwin -p atlas` before and after must be identical |
| bwrap under AppArmor on Ubuntu 24.04 makes the agent look broken                      | Phase 1 step 5's probe reports it in words; Phase 7 documents the sysctl and the profile; the deb could later ship a profile                                         |
| Lowering the glibc floor to 22.04 pulls an older WebKitGTK and a rendering regression | Phase 6 matrix includes 22.04; Phase 0's AppImage smoke runs on the 22.04 container                                                                                  |
| The dry-run job doubles CI time for app changes                                       | Gate it on the `changes` filter above; the engine and app compile are cached by sccache; accept the cost on release-input paths only                                 |
| Signing key leaks or is lost                                                          | Decision item for the user; the plan ships provenance attestation regardless, which needs no custody                                                                 |

## Decisions the user owns

1. glibc floor: `ubuntu:22.04` (recommended) or stay on 24.04.
2. Ship aarch64 Linux in the same release as x86-64 (recommended yes; the script and
   runners exist).
3. Bundle bubblewrap in the AppImage and tarball (recommended yes).
4. Signing key custody for Phase 4.
5. Whether Flatpak is wanted. It is not in this plan; it would be a Phase 8 with its own
   sandbox interaction (Flatpak's own sandbox versus the engine's bubblewrap), and needs
   research before committing.
