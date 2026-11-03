# Linux support

What Atlas supports on Linux, what each package needs, and how a Linux release is
built, checked, signed and announced.

- **Source of truth:** `.github/workflows/release-linux.yml` and the scripts it calls
  (`scripts/package-linux.sh`, `scripts/verify-linux-release.sh`, `scripts/linux/`).
- **Why it is shaped this way:** [`docs/research/linux-release-plan.md`](../research/linux-release-plan.md).

## Supported systems

Atlas runs where two things hold: glibc 2.35 or newer, and WebKitGTK 4.1. The release is
built on Ubuntu 22.04 so the binary needs nothing newer, and `Verify` fails a build whose
binary does.

| family                                   | supported from | package                            |
| ---------------------------------------- | -------------- | ---------------------------------- |
| Ubuntu                                   | 22.04          | deb                                |
| Debian                                   | 12             | deb                                |
| Fedora                                   | 36             | rpm                                |
| RHEL, Rocky, Alma                        | 10             | rpm                                |
| Arch, Manjaro, EndeavourOS               | rolling        | Arch package or AUR `tryatlas-bin` |
| anything else meeting the two conditions |                | AppImage or tarball                |

Both x86-64 and aarch64 are built. Ubuntu 20.04, Debian 11 and RHEL 8 are not supported:
their WebKitGTK predates 4.1. RHEL 9 is not supported either: its glibc is 2.34. Moving the floor means changing the runner in
`release-linux.yml` and the `GLIBC_FLOOR` its `Verify` step checks, together with this
table.

## Packages

Every package installs the binary as `atl`, with a `tryatlas` link. `atlas` is left to
the Atlas CLI.

| artifact                                                     | installs                                          | runtime dependencies                                                    |
| ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `tryatlas_<ver>_<arch>.deb`                                  | system-wide, by `apt install ./…`                 | declared, from `scripts/linux/runtime-deps.sh`                          |
| `tryatlas-<ver>-1.<arch>.rpm`                                | system-wide, by `dnf install ./…`                 | declared, plus every linked library read from the binary                |
| `tryatlas-bin-<ver>-1-x86_64.pkg.tar.zst` and the AUR recipe | system-wide, by pacman                            | declared, from the same list                                            |
| `tryatlas_<ver>_<arch>.AppImage`                             | nowhere; runs in place                            | must already be present, except bubblewrap, which it carries            |
| `atlas-<ver>-linux-<arch>.tar.gz`                            | `install.sh`: `~/.local`, or `/usr/local` as root | must already be present; the installer warns when bubblewrap is missing |

`scripts/linux/runtime-deps.sh` is the one list of runtime dependencies, one row per
capability in each family's names; `tests/linux-packaging.test.ts` keeps every package
builder reading it.

## The agent's sandbox: bubblewrap

The native agent runs every command it executes inside the engine's Linux sandbox:
seccomp in-process, and bubblewrap (`bwrap`) for the filesystem and network. Without a
working bubblewrap, those commands fail. The packages depend on it; the AppImage carries
a copy (`scripts/linux/build-bwrap.sh`), used only when the system has none.

At engine start Atlas checks that bubblewrap can create the namespaces the sandbox needs,
and logs a warning that says why when it cannot. The two usual causes:

- **bubblewrap is not installed.** Install the distro's `bubblewrap` package.
- **Unprivileged user namespaces are restricted.** Ubuntu 24.04 and later set
  `kernel.apparmor_restrict_unprivileged_userns=1` and allow namespaces only to programs
  with an AppArmor profile. The distro's `/usr/bin/bwrap` has one, so the deb and a
  system-installed bubblewrap work; the AppImage's bundled copy does not, which is why
  the system one is preferred. On distros that disable user namespaces outright
  (`kernel.unprivileged_userns_clone=0`, or `user.max_user_namespaces=0`), the sandbox
  cannot run at all.

Known issue: on at least one Ubuntu 26.04 machine, stopping a turn does not stop a
sandboxed command that is already running. See finding L1 in
[`docs/qa/linux-smoke-matrix.md`](../qa/linux-smoke-matrix.md).

## CPU at idle

Two things cost nothing on macOS and most of a core on Linux. Both are fixed
in code and each has a suite that fails if the fix is undone.

- **A read is an event.** notify's inotify backend subscribes to `IN_OPEN`, so
  on Linux every read of a watched file or directory arrives as an
  `EventKind::Access`. A watcher whose callback reads something to interpret an
  event (`.gitignore`, `.git/index`, `config.toml`) woke itself and every other
  watcher on the tree: an idle project measured ~1,300 events/s and 75% of a
  core. Every watcher in `src-tauri` now drops `Access` first
  (`src-tauri/src/fs_events.rs`; `tests/watcher-access-filter.test.ts`).
- **A frame per animation tick.** WebKitGTK presents a full-window frame for
  every tick of an accelerated animation, and the UI process pays for each on
  its main thread: the sidebar's 14 px working ring, turning while a terminal
  session is live, measured 29% of a core. Under `html.platform-linux` every
  infinite animation runs with `steps()` timing near 12 fps (the block at the
  end of `src/styles/globals.css`; `tests/linux-animation-steps.test.ts`): the
  ring now costs 9%.

What remains: while a session of the open project is live in another process
(Claude Code in a terminal, typically), Atlas sits at ~9% on the UI process and
~9% on the web process, and at ~1% each once that session goes quiet. That
residue is not rendering (it survives reduced motion and a frozen screen) and
is not the file watchers; it has not been traced further. Measure with the
project open and a terminal session writing, and compare against the same
window 90 s after the terminal's last write.

## Updates

Linux never downloads or installs an update. When a newer version is published, Atlas
shows a notice with a link to the release page, and "Skip this version" silences it
(`src-tauri/src/commands/updater_linux.rs`). The notice needs two PostHog remote-config
keys, `uri_linux_x86_64` and `uri_linux_aarch64`, set to the release page; until a key
is set, that architecture is told nothing. The link is accepted only on the project's
own GitHub releases or `tryatlas.cc`.

How the update is then installed depends on the package: the deb, rpm and Arch package
by downloading the new one (or `yay -S tryatlas-bin` for the AUR), the AppImage and
tarball by replacing the file.

## Signing

Every release carries two kinds of integrity evidence.

- **Build provenance**, always. The publish job attests every artifact with
  `actions/attest-build-provenance`, tying it to the workflow run that built it. Anyone
  can check a download with:

  ```bash
  gh attestation verify tryatlas_0.4.2_amd64.deb --repo pacifio/atlas
  ```

- **GPG signatures**, once the release key exists. `scripts/linux/sign-release.sh` signs
  each rpm in place and writes `SHA256SUMS.txt.asc`, a detached signature over the
  checksum file, which covers every other artifact. The public key ships beside them as
  `atlas-release-signing-key.asc`. Until the key exists, the publish job skips both and
  leaves a warning titled "Linux release unsigned" on the run.

To check a download against the signed checksums:

```bash
gpg --import atlas-release-signing-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --ignore-missing -c SHA256SUMS.txt
```

A key published beside the files it signs proves only that they were not changed after
signing. Its fingerprint should also be published somewhere the release does not
control, such as the website, so users can tell it is the real one.

### Creating the release key

A maintainer does this once. Who holds the key and how it is rotated is a decision for
the maintainers, not something the workflow decides.

```bash
# RSA 4096 rather than ed25519: older rpm builds (RHEL 8 era) cannot verify EdDSA.
gpg --quick-gen-key 'Atlas Release Signing <contact@tryatlas.cc>' rsa4096 sign 2y
gpg --armor --export-secret-keys <fingerprint> > atlas-release.key   # keep offline
```

Then add two repository secrets:

| secret                         | value                                            |
| ------------------------------ | ------------------------------------------------ |
| `LINUX_RELEASE_GPG_KEY`        | the armored private key (`atlas-release.key`)    |
| `LINUX_RELEASE_GPG_PASSPHRASE` | its passphrase, or leave unset for no passphrase |

The next release is signed. Delete the local `atlas-release.key` once it is stored
wherever the maintainers keep offline secrets.
