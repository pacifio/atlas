---
status: accepted
---

# Vendor seatbelt, rather than depend on codex-sandboxing

Atlas runs model-authored shell commands and file edits at the desktop app's full
privilege with no OS-level containment, and Codex has a mature three-platform
sandbox available under Apache-2.0. We will **vendor** `sandboxing/src/seatbelt.rs`
and its three `.sbpl` policy profiles, backed by a small local policy struct, rather
than take a Cargo dependency on `codex-sandboxing`.

## Considered options

Depending on `codex-sandboxing` costs **200 net-new crates on a macOS build** — a
~31% increase over Atlas's compiled closure — because `codex-windows-sandbox` is
declared outside any `cfg(windows)` block and transitively pulls an OTLP exporter,
a SOCKS5 proxy stack, an image decoder, and a Starlark interpreter. The crate has
no `[features]` section, so there is no supported way to opt out.

`codex-execpolicy` was also rejected: 77 net-new crates for the Starlark
interpreter, and it ships **zero** rules — the only policy file in the repo is an
example whose header says it is "not recommended for actual use."

Enabling the Cersei SDK's own `vms` sandbox was rejected because its only two
backends are `LocalProcessRuntime` (documented as "no isolation") and
`DockerRuntime` (requires Docker on PATH). A desktop app cannot require Docker to
be safe by default.

## Consequences

The vendored code inherits the vendoring obligations in ADR-0002: an `UPSTREAM.md`
with a pinned revision, and a rebase cadence — seatbelt profiles are adversarially
maintained, and a stale copy silently keeps any hole upstream later patches.

macOS needs nothing else shipped; `/usr/bin/sandbox-exec` is part of the OS. Linux
enforcement is deferred because it requires shipping the `codex-linux-sandbox`
binary as a Tauri `externalBin` sidecar, which is a packaging workstream rather
than a code change. Windows is deferred with no path short of the rejected
dependency.

Containment (see CONTEXT.md) is landing separately and first. It is advisory: it
binds Atlas's file tools but not the shell, so it does not substitute for this.

## What was built

`crates/atlas-cersei/src/tools/sandbox/`, with `ATTRIBUTION.md` recording the
Apache-2.0 provenance.

Vendored: `seatbelt_base_policy.sbpl` and `seatbelt_network_policy.sbpl`, verbatim
apart from a header comment. That data is the expensive, hard-won part — Codex's
own header credits Chromium's macOS sandbox policy as its ancestor.

Not vendored: `seatbelt.rs` itself. It is written against `codex_network_proxy`,
`codex_protocol` and `codex_utils_absolute_path`, and most of its bulk is proxy
and managed-network policy Atlas does not have (network mediation is explicitly
out of scope in the harness spec). Atlas's generator — compose the base, add
workspace-scoped write rules and a credential deny list, pass paths as `-D`
parameters rather than interpolating them — is about a hundred and fifty lines.

Net new crates: **zero**. `include_str!` on two policy files needs no dependency.

`tests/sandbox_tier0.rs` establishes the behaviour against the real kernel: the
workspace is readable and writable, `~/Library/Keychains` is not, ordinary
toolchain reads still work, and a workspace path containing quotes and parens
cannot rewrite the profile.
