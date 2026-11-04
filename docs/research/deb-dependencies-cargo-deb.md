# Does cargo-deb's `$auto` fix the deb's dependency problems?

_Research note, 2026-11-04, branch `maklu/linux-release` at `5f98ac4e`. Measured on Ubuntu 26.04.1 (glibc 2.43, libstdc++6 16-20260322-1ubuntu1, dpkg-dev 1.23.7ubuntu1, cargo-deb 3.8.0) against `target/release/atlas` built on this host by `bun run build:app:linux`. No docker/podman here, so nothing below was installed on a clean container; `verify-linux-release.sh` does that in CI._

## Verdict

`$auto` is `dpkg-shlibdeps` (§1). It reads the ELF's DT_NEEDED list and the **build host's** `symbols`/`shlibs` files, so it names the build host's packages at the build host's versions. That is the whole story, and it cuts both ways:

- **What the hand list gets wrong:** nothing that `verify-linux-release.sh` lets ship. The list is coarse (no versions, misses `libstdc++6`, `libsoup-3.0-0`, `libcairo2`, `libdbus-1-3`, `libgdk-pixbuf-2.0-0`, `libjavascriptcoregtk-4.1-0`), but every one of those is a hard dependency of `libwebkit2gtk-4.1-0`/`libgtk-3-0`, and the deb is built on the 22.04 floor, so the versions a build there would compute are the oldest anything in the support matrix ships (§4, §5). The three install containers prove the list resolves and the binary loads (§8).
- **What `$auto` fixes:** the one failure the hand list cannot see, a binary that needs a newer libstdc++/glibc than the target. It fails at _install_ ("depends on libstdc++6 (>= 14)") instead of at _launch_ ("version `CXXABI_1.3.15' not found"). On this host that floor is real, not an artefact: the binary imports `__cxa_call_terminate@CXXABI_1.3.15`, introduced in GCC 14 (§4). But the release builder is 22.04, where that floor is already the minimum, so for the release deb `$auto` would add versions that every supported distro satisfies.
- **What `$auto` introduces:** host-specific package names. Built on a t64 host it writes `libglib2.0-0t64`, `libgtk-3-0t64`; those packages do not exist on Ubuntu 22.04 or Debian 12, so the deb is uninstallable there, while the hand-written `libglib2.0-0` installs everywhere because t64 packages `Provides:` the old name (§3). It also cannot see dlopen'd `libayatana-appindicator3` or exec'd `bwrap` (§2), so the hand list stays either way.
- **Recommendation for the release deb** (done in the commit after this note): keep the hand list as the source of truth. Add `dpkg-shlibdeps` to `package-linux.sh` as a _check_, not as the Depends line: run it on the 22.04 builder and fail if it emits anything the hand list (plus `libc6`) does not cover with an installable name, or a version above the floor. That catches a toolchain drift (a newer GCC in the runner image, a `cc`-built C++ dependency) at package time instead of in a user's terminal, without letting a host's package names into the control file. Replacing the hand list with `$auto` on the release builder would be safe _today_ and would silently break the day the runner moves to a t64 image, which is exactly the kind of failure `release-linux.yml` already warns about for glibc. Leave the local `cargo-deb.sh` path as it is: it builds for this host.

## 1. What `dpkg-shlibdeps` does

`man dpkg-shlibdeps` (dpkg 1.23.7, this host): "For each binary that dpkg-shlibdeps analyzes, it finds out the list of libraries that it's linked with. Then, for each library, it looks up either the symbols file, or the shlibs file … The package name is identified in two steps: find the library file on the system (looking in the same directories that ld.so would use), then use `dpkg -S library-file` to lookup the package providing the library." And for versions: "While scanning the symbols used by all binaries, dpkg-shlibdeps remembers the (biggest) minimal version needed for each library."

Debian Policy §8.6 ([ch-sharedlibs](https://www.debian.org/doc/debian-policy/ch-sharedlibs.html)): a `symbols` file gives "for each symbol exported by a library, the minimal version of the package" a user needs; a `shlibs` file "only documents the last time the library ABI changed in any way". §8.6.3.2: a symbol's `minimal-version` is "the most recent version of the shared library that changed the behavior of that symbol", and that is the restriction written out.

Consequence: both the names (`dpkg -S` on _this_ system's files) and the versions (_this_ system's symbols files) are the build host's. The version is the newest-introduced symbol the binary imports, which is a true floor for that library's ABI, but a floor expressed in the host distro's package versioning.

## 2. What it cannot see

- **libayatana-appindicator is dlopen'd.** `~/.cargo/registry/src/*/libappindicator-sys-0.9.0/src/lib.rs:9-36`: `use libloading::*;` then `Library::new("libayatana-appindicator3.so.1")`, falling back to `libappindicator3.so.1` and the unversioned `.so` names. The binary's DT_NEEDED (`objdump -p`) has no appindicator entry and `objdump -T | grep -c app_indicator` is 0. So no `symbols`/`shlibs` lookup happens for it; the `$auto` output in the brief confirms it came from the hand list. Policy §8.6 asks dlopen users to "compute appropriate dependencies using these files at build time as well", i.e. by hand.
- **bubblewrap is exec'd.** `vendor/atlas-engine/sandboxing/src/bwrap.rs:169` `find_system_bwrap_in_path()` searches `PATH`; `crates/atlas-native-agent/src/linux_sandbox.rs:102-111` runs it with `std::process::Command`. Not an ELF dependency at all. `runtime-deps.sh` already documents this.

The hand list is therefore required under `$auto` too, and `[package.metadata.deb]` is right to union them.

## 3. The t64 transition

On this host (Ubuntu 26.04), `apt-cache show libglib2.0-0t64`: `Provides: … libglib2.0-0 (= 2.88.0-1ubuntu0.1) …`, `Replaces: libglib2.0-0 (<< 2.80.0-7~)`; `libgtk-3-0t64`: `Provides: gtk3-binver-3.0.0, libgtk-3-0 (= 3.24.52-0ubuntu1)`. `apt-cache showpkg libglib2.0-0` shows no real package, only "Reverse Provides: libglib2.0-0t64". So a hand-written, _unversioned_ `libglib2.0-0` resolves to the t64 package on 24.04+/Debian 13. (A versioned `libglib2.0-0 (>= x)` also works, because the Provides is versioned.)

The other direction does not hold. Ubuntu 22.04 ships `libglib2.0-0 2.72.4-0ubuntu2.10` ([packages.ubuntu.com/jammy/libglib2.0-0](https://packages.ubuntu.com/jammy/libglib2.0-0)), Debian 12 ships `libglib2.0-0 2.74.6-2+deb12u9` ([packages.debian.org/bookworm/libglib2.0-0](https://packages.debian.org/bookworm/libglib2.0-0)), and neither has a `libglib2.0-0t64`; the t64 name first appears in noble (`2.80.0-6ubuntu3.9`) and trixie (`2.84.4-3~deb13u5`). A deb whose Depends says `libglib2.0-0t64 (>= 2.66.0)` is uninstallable on the two floor distros of the support matrix. The Debian 13 release notes confirm the scope ("All architectures other than i386 now use a 64-bit time_t ABI"); the wiki page `ReleaseGoals/64bit-time` returned HTTP 403 to the fetcher, so the Provides above is the primary evidence here.

## 4. The `libstdc++6 (>= 14)` finding

The brief's puzzle: `$auto` emitted `libstdc++6 (>= 14)` although the binary's newest `GLIBCXX_` tag is `GLIBCXX_3.4.22`. Resolved by `dpkg-shlibdeps -v` and the host's symbols file:

```
$ nm -D --undefined-only target/release/atlas | grep __cxa_call_terminate
                 U __cxa_call_terminate@CXXABI_1.3.15
$ grep -n __cxa_call_terminate /var/lib/dpkg/info/libstdc++6:amd64.symbols
6091: __cxa_call_terminate@CXXABI_1.3.15 14
```

The newest tag is on the CXXABI side, not GLIBCXX. The GCC libstdc++ ABI page ([gcc.gnu.org/onlinedocs/libstdc++/manual/abi.html](https://gcc.gnu.org/onlinedocs/libstdc++/manual/abi.html)) lists "GCC 14.1.0: GLIBCXX_3.4.33, CXXABI_1.3.15" and "GCC 13.2.0: GLIBCXX_3.4.32, CXXABI_1.3.14", so the symbol exists only in libstdc++ from GCC 14 on. The host compiler is `g++ (Ubuntu 15.2.0-16ubuntu1)`, which emitted it into one of the `cc`/`cxx`-built C++ dependencies (`Cargo.lock` has `aws-lc-sys`, `cxx`, `libsqlite3-sys`, `mimalloc`, `onig_sys`). `libstdc++6 (>= 14)` is therefore a **correct** floor for this binary: on Ubuntu 22.04 (libstdc++6 `12.3.0-1ubuntu1~22.04.3`, [packages.ubuntu.com/jammy/libstdc++6](https://packages.ubuntu.com/jammy/libstdc++6)) or Debian 12 (`12.2.0-14+deb12u1`) the dynamic loader would refuse it with "version `CXXABI_1.3.15' not found", because the ABI page's versioning rule is "only symbols which are newly introduced will use the maximum version definition" and an older library simply lacks that version node.

That is the one class of problem `$auto` catches and the hand list does not: the hand list has no `libstdc++6` entry at all, so the deb installs and the app dies at launch. It bites only when the deb is built on a host newer than the floor. On the 22.04 builder, GCC 11/12 cannot emit a symbol newer than its own libstdc++, so the computed floor is ≤ 12 and every supported distro satisfies it. (The GLIBC_2.43 floor on this host, `asinf@GLIBC_2.43` from `libmvec`, has the same shape: real, and only because the build host is new.)

## 5. The glibc floor: `objdump -T | grep GLIBC_` versus shlibdeps

Equivalent in result, different in mechanism. `package-linux.sh` takes the highest `GLIBC_x.y` version tag the binary references (2.43 here); `dpkg-shlibdeps` looks each imported symbol up in `/var/lib/dpkg/info/libc6:amd64.symbols` and keeps the biggest `minimal-version` (also 2.43 here: `libc6 (>= 2.43)`). glibc's symbols file maps `sym@GLIBC_x.y` to `x.y`, so the two agree whenever the binary's newest tag is also its newest symbol, which is the normal case; shlibdeps can only be _higher_ if Debian bumped a symbol's minimal version for a behaviour change without a new tag (Policy §8.6.2). The script's method needs no `symbols` file and so works on any host; shlibdeps' needs the host's libc6 metadata. For the release, either is fine; the script's version is already what `verify-linux-release.sh` holds to `GLIBC_FLOOR=2.35`.

## 6. Running `dpkg-shlibdeps` without cargo-deb

It is in `dpkg-dev`, a dependency of `build-essential` (`apt-cache depends build-essential` → `Depends: dpkg-dev`), so it is on the 22.04 runner already. The man page documents `-O[filename]`: "Print substitution variable settings to standard output … rather than being added to the substitution variables file". It must be run from a directory with a readable `debian/control`; an empty file suffices. Measured on this host:

```
$ mkdir -p sd/debian && cd sd && touch debian/control
$ dpkg-shlibdeps -O /home/maklu/Codes/atlas/target/release/atlas
dpkg-shlibdeps: warning: diversions involved - output may be incorrect
 diversion by libc6 from: /lib64/ld-linux-x86-64.so.2
dpkg-shlibdeps: warning: diversions involved - output may be incorrect
 diversion by libc6 to: /lib64/ld-linux-x86-64.so.2.usr-is-merged
dpkg-shlibdeps: warning: binaries to analyze should already be installed in their package's directory
shlibs:Depends=libc6 (>= 2.43), libcairo2 (>= 1.10.0), libdbus-1-3 (>= 1.10), libgcc-s1 (>= 4.2), libgdk-pixbuf-2.0-0 (>= 2.36.9), libglib2.0-0t64 (>= 2.66.0), libgtk-3-0t64 (>= 3.21.5), libjavascriptcoregtk-4.1-0, libsoup-3.0-0 (>= 3.0.3), libstdc++6 (>= 14), libwebkit2gtk-4.1-0 (>= 2.41.90)
$ cd .. && dpkg-shlibdeps -O /home/maklu/Codes/atlas/target/release/atlas
dpkg-shlibdeps: error: cannot read debian/control: No such file or directory   (exit 25)
```

The three warnings are harmless for a one-off call (the usr-merge diversion, and the binary not sitting in a `debian/<pkg>/` tree). `--ignore-missing-info` exists for a library with no `symbols`/`shlibs` file; not needed here, every DT_NEEDED library had one. Note `libgcc-s1 (>= 4.2)` in the raw output: cargo-deb's list in the brief lacks it, so cargo-deb post-processes the output (cargo-deb's README does not say how; see §7).

## 7. cargo-deb's documentation of `$auto`

The README ([kornelski/cargo-deb](https://raw.githubusercontent.com/kornelski/cargo-deb/main/README.md)) says of `depends`: "Generated automatically when absent, or if the list includes the `$auto` keyword", and its install line is "Requires Rust 1.76+, and optionally `dpkg`, `dpkg-dev` and `liblzma-dev`". It does not name `dpkg-shlibdeps`, does not warn about dlopen or about host-specific names/versions, and says nothing about `$auto` under cross-compilation beyond "run `cargo deb --target=… --no-build`". `cargo deb --help` (3.8.0) has no `$auto` flag of its own; `--no-build` and `--no-strip` are the two `scripts/linux/cargo-deb.sh` uses. So the caveats in §1-§4 come from dpkg, not from cargo-deb's docs, and nothing in cargo-deb limits them.

## 8. What `verify-linux-release.sh` already proves

With `VERIFY_INSTALL=1` (set in `release-linux.yml:294`) it `apt-get install`s the deb on `ubuntu:22.04`, `debian:12` and `ubuntu:24.04`, runs `atl mcp-bridge` (which must reach `main` and print its usage), and removes it. Its own comment: "the only check that proves the hand-typed Depends/Requires lines name real packages". The 24.04 leg is the t64 case for the hand list (§3); the 22.04/12 legs are where a `$auto` deb from a new host would fail at install, and where a hand-list deb from a new host would fail at the `mcp-bridge` probe with the libstdc++ error (§4). Both failure modes are already caught _for the release deb_ because the probe runs the binary; neither is caught for a local `cargo-deb.sh` build, which nobody installs on a container. The one hole: an ELF that loads but needs a newer library only on a code path the probe never reaches. `dpkg-shlibdeps` closes that at package time; the install check does not.

## Sources

- `man dpkg-shlibdeps` (dpkg 1.23.7, this host); [manpages.debian.org/trixie/dpkg-dev/dpkg-shlibdeps.1](https://manpages.debian.org/trixie/dpkg-dev/dpkg-shlibdeps.1.en.html)
- Debian Policy §8.6: https://www.debian.org/doc/debian-policy/ch-sharedlibs.html
- GCC libstdc++ ABI: https://gcc.gnu.org/onlinedocs/libstdc++/manual/abi.html
- cargo-deb README: https://github.com/kornelski/cargo-deb
- Debian 13 release notes, what's new: https://www.debian.org/releases/trixie/release-notes/whats-new.en.html
- Package versions: packages.ubuntu.com (jammy `libstdc++6`, `libglib2.0-0`; noble `libglib2.0-0t64`), packages.debian.org (bookworm `libstdc++6`, `libglib2.0-0`; trixie `libglib2.0-0t64`)
- Repo: `scripts/package-linux.sh`, `scripts/linux/runtime-deps.sh`, `scripts/linux/cargo-deb.sh`, `src-tauri/Cargo.toml` `[package.metadata.deb]`, `scripts/verify-linux-release.sh`, `.github/workflows/release-linux.yml:67-84`, `crates/atlas-native-agent/src/linux_sandbox.rs`, `vendor/atlas-engine/sandboxing/src/bwrap.rs`
- `~/.cargo/registry/src/*/libappindicator-sys-0.9.0/src/lib.rs`

## 9. The Debian 13 symptom, and why no packager fixes it

The failure that prompted this: a deb built on this machine refused by Debian 13 with
`tryatlas depends on libc6 (>= 2.43); however: version 2.41-… is installed`. Debian 13
(trixie) ships glibc 2.41. The binary built here imports `asinf@GLIBC_2.43` through
libmvec (§5), so 2.43 is its true floor: the `objdump` floor in `package-linux.sh` and
`dpkg-shlibdeps` under cargo-deb both compute 2.43, and a deb that claimed less would
install and then fail at launch with `version 'GLIBC_2.43' not found`. The Depends line is
reporting the problem, not causing it.

The floor is set by the glibc of the machine that links the binary, so the only fix is to
build on an older one. The release does: `release-linux.yml` builds on Ubuntu 22.04
(glibc 2.35) and `Verify` fails any binary whose floor is above `GLIBC_FLOOR=2.35`, so a
release deb installs on Debian 12, Debian 13 and Ubuntu 22.04 onward. A local build can
match it only by building inside an `ubuntu:22.04` container (no runtime is installed on
this machine) or by pushing an `alpha-*` tag and taking the workflow's packages; the
pull-request dry run builds them but does not upload them.
