# Attribution — macOS sandbox policy data

`base_policy.sbpl` and `network_policy.sbpl` are vendored verbatim (modulo a
header comment) from **OpenAI Codex**, Apache License 2.0:

- `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`
- `codex-rs/sandboxing/src/seatbelt_network_policy.sbpl`
- https://github.com/openai/codex

Codex's own header notes that the base policy is itself inspired by Chromium's
macOS sandbox policy (`sandbox/policy/mac/common.sb`, `renderer.sb`), BSD-3-Clause.

## What is vendored and what is not

Per `docs/adr/0001-vendor-seatbelt-rather-than-depend-on-codex-sandboxing.md`,
Atlas vendors the **policy data** and writes its own generator.

Taking `codex-sandboxing` as a Cargo dependency costs roughly two hundred
net-new crates on a macOS build, because `codex-windows-sandbox` is not
target-gated, and it drags in an OTLP exporter, a proxy stack, an image decoder,
and a Starlark interpreter in order to produce a command line.

Lifting `seatbelt.rs` itself is also not viable: it is written against
`codex_network_proxy`, `codex_protocol` and `codex_utils_absolute_path`, and
most of its bulk is proxy and managed-network policy that Atlas does not have
(network mediation is explicitly out of scope in the harness spec). The parts
Atlas needs — compose the base policy, add workspace-scoped write rules, pass
paths as `-D` parameters rather than interpolating them into the profile text —
are about a hundred and fifty lines and live in `seatbelt.rs` in this directory.

## Upstream revision

ADR-0001 requires the vendored revision to be pinned so the rebase cadence has
an anchor. The revision was not recorded when the files were first vendored
(2026-08-18); what is known for certain is the upstream paths above and the
vendoring date. **The next sync against `openai/codex` must record the exact
upstream commit here** — diff `seatbelt_base_policy.sbpl` and
`seatbelt_network_policy.sbpl` against upstream, apply what changed, and write
the commit hash on the line below.

- Vendored: 2026-08-18, upstream revision unrecorded (pin at next sync).

## Apache License 2.0

```
Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
