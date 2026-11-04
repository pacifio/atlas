# Linux: release smoke matrix

The by-hand check for a Linux release, from Phase 6 of
`docs/research/linux-release-plan.md`. CI's `Verify` step (release-linux.yml) already
proves each package installs, loads and starts on clean distro containers; what it
cannot do is sit at a real desktop. This matrix is that part. Run it before the first
tagged release that carries the Linux sandbox fix, and for each Linux release after,
until it is automated. Each run gets its own dated section below; earlier runs are not
rewritten.

## Cells

One install per cell, from the release's own artifacts, on a real machine or a VM with
a desktop session (not a container).

| cell | distro and session                                     | package  | why this cell                                 |
| ---- | ------------------------------------------------------ | -------- | --------------------------------------------- |
| A    | Ubuntu 22.04, GNOME, Wayland                           | deb      | the glibc 2.35 floor                          |
| B    | Ubuntu 24.04, GNOME, Wayland                           | AppImage | AppArmor's user-namespace restriction, no deb |
| C    | Debian 12, GNOME, X11                                  | deb      | oldest Debian, X11 clipboard                  |
| D    | Fedora (current), GNOME, Wayland                       | rpm      | the other soname family; signed rpm           |
| E    | Arch, KDE Plasma, Wayland                              | Arch pkg | rolling; the AUR recipe                       |
| F    | Arch or any, Sway (tiling, no server-side decorations) | tarball  | `decorations: false` on a tiling compositor   |
| G    | any, aarch64 (e.g. a Raspberry Pi 5 or an ARM VM)      | AppImage | the aarch64 build                             |

## Checks, per cell

| #   | check                                                                                          | expected                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Install, then launch from the desktop entry                                                    | Atlas appears in the app launcher with its icon, and opens.                                                                                                     |
| 2   | Window chrome                                                                                  | Move, resize from every edge, maximise, minimise and close all work with `decorations: false`. On a tiling compositor the window tiles without clipped content. |
| 3   | Sign in, open a project, start a native-agent chat                                             | The chat connects. The log shows no "bubblewrap" warning at engine start (or, in cell B without the AppArmor profile, the warning names the restriction).       |
| 4   | Ask the agent to run `uname -a` and write a file in the project                                | The command runs and its output appears in the tool row; the file exists. This is the sandbox; before the fix it ran nothing.                                   |
| 5   | Ask for a long command (`sleep 30; touch done`) and press Stop                                 | The turn stops and `done` never appears.                                                                                                                        |
| 6   | Copy a message, paste into another app                                                         | The text arrives (Wayland: `wl-copy`; X11: `xclip`/`xsel`).                                                                                                     |
| 7   | Leave a turn running and switch away                                                           | A desktop notification arrives when it finishes.                                                                                                                |
| 8   | Run a long turn                                                                                | The machine does not idle-sleep during it (keep-awake inhibitor).                                                                                               |
| 9   | Open a file in the external editor; open a terminal tab                                        | Both open.                                                                                                                                                      |
| 10  | Settings → Updates → Check now, with a newer `version` and `uri_linux_<arch>` in remote config | A notice names the version; "Release page" opens it; "Skip this version" stops further notices for it.                                                          |
| 11  | Uninstall                                                                                      | `atl`, `tryatlas`, the desktop entry and the icons are gone.                                                                                                    |

## Run 1: 2026-11-03, partial (development machine)

Not a release run: no release artifacts existed yet for this branch, so this is the one
cell reachable from the machine the work was done on.

- **Machine:** Ubuntu 26.04, x86-64, niri (Wayland), `kernel.apparmor_restrict_unprivileged_userns=1`
  with the distro's AppArmor profile for `/usr/bin/bwrap`.
- **Build:** debug build of `maklu/linux-release` at `f0ef0880`, run from `target/`, with a
  fresh `HOME`. Not installed from a package, so checks 1, 10 and 11 do not apply.

| #      | outcome                                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | **Pass (partial).** Launched directly; stayed up for the whole 40 s window with no panic.                                                                                                                                                                                                                             |
| 3      | **Partial.** Not signed in, so the engine did not start. The sandbox alias was installed in the engine home pointing at the running binary (`…/dev.atlas.ide/atlas-agent/engine/linux-sandbox/atlas-engine-linux-sandbox`). `bwrap --unshare-all --ro-bind / / true` succeeds on this machine.                        |
| 4      | **Pass, through the test suite rather than the UI.** `cargo test -p atlas-native-agent` runs sandboxed commands through the engine on this machine (33 of 34 `engine_turn` tests pass), and the app binary started as `atlas-engine-linux-sandbox` is the sandbox helper (it prints the helper's usage, not the app). |
| 5      | **Fail, before and after this work** (finding L1 below).                                                                                                                                                                                                                                                              |
| 2, 6–9 | Not run: they need a person at the desktop.                                                                                                                                                                                                                                                                           |

### Finding L1: a cancelled sandboxed command keeps running

`cargo test -p atlas-native-agent --test engine_turn cancelling_mid_tool` fails on this
machine with and without the Linux changes: after one cancel the turn ends, but the
command finishes its `sleep` and writes its marker file.

The engine stops a command by killing the sandbox helper's process group. The helper
execs bubblewrap with `--new-session --die-with-parent`, so the command leaves that group
and only bubblewrap's parent-death signal can stop it. On this machine that signal never
fires. Reproduced with bubblewrap 0.11.1 alone, no Atlas involved:

```bash
# Survives: the group kill cannot reach the new session, and nothing else stops it.
setsid bash -c "exec bwrap --new-session --die-with-parent --bind / / -- sh -c 'sleep 3; touch /tmp/survived'" &
sleep 1; kill -KILL -- -$(ps -o pgid= -p $! | tr -d ' ')
# Without --new-session the command dies, but only because the group kill reaches it.
```

Cause not confirmed (it needs root to test). The likely one: Ubuntu's AppArmor profile
for `bwrap` changes the command's credentials when it execs, and the kernel clears the
parent-death signal on such a change. CI cannot see it, because its sandbox job turns
`kernel.apparmor_restrict_unprivileged_userns` off. So it probably affects every Ubuntu
24.04+ desktop, the most common Linux install.

Not fixed here. The candidate fixes change the engine's sandbox hardening, which is a
decision to make deliberately:

- Have the helper stay as bubblewrap's parent and kill the sandbox's session itself on
  SIGTERM/SIGKILL of its group, instead of exec'ing bubblewrap.
- Use bubblewrap's `--sync-fd` or the helper's pidfd to tie the command's lifetime to
  something the engine's kill does reach.
- Drop `--new-session` where the kernel already blocks TIOCSTI
  (`dev.tty.legacy_tiocsti=0`, Linux 6.2+). This weakens the sandbox on older kernels.

Checking it on a CI-like Ubuntu 24.04 with the restriction on (`ci:local --linux` with
the sysctl left at 1) would confirm the cause before choosing.
