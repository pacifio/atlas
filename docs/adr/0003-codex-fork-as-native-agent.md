# ADR-0003: A one-time port of Codex replaces the Cersei SDK as the native agent's engine

**Status:** Accepted (2026-08-27)

## Context

Atlas's native agent runs on the Cersei SDK — the crates.io `cersei*` crates wrapped by `crates/atlas-cersei`. Cersei was an experimental SDK: a stopgap to get a native agent working at all, never intended to be what shipped. That experiment is over.

The decisive problem is ownership, not any single bug. Every defect hit in the Cersei path could be fixed only by maintaining a private fork of someone else's crate, and two such forks exist today: `vendor/cersei-provider` (the UTF-8 SSE decoder corruption) and `vendor/cersei-agent` (the tool-cancel race), both pinned via `[patch.crates-io]` in `src-tauri/Cargo.toml` and both redone against every upstream release. The user-visible failures that prompted this decision — dropped connections and fragile streaming — are symptoms of not owning the engine, not the reason to leave: both named streaming bugs were root-caused and patched. What is being exited is the treadmill of fixing symptoms one vendored fork at a time.

Codex (`openai/codex`, Rust, Apache-2.0) is chosen specifically because it already ships the reliability machinery the full-app audit found missing from the native path — clean cancellation, retry on failure — which would otherwise have to be built from scratch on a substrate we do not own.

## Decision

Delete the Cersei path and replace its engine with a one-time port of Codex.

- **Deleted:** the Cersei SDK dependency (all crates.io `cersei*` crates and both vendored patch forks) and `crates/atlas-cersei`. `crates/atlas-native-agent` is the seam the app plugs into, not the engine, and is **not** on this list — see CONTEXT.md ("Retiring the name Cersei") for what "Cersei" may and may not refer to while the port is in flight.
- **A hard fork, ported once.** Full Codex functionality, rebranded, repointed at our LLM provider. Fork point: `openai/codex` @ `42b5f05` (2026-08-14). From cutover the engine is ours and we maintain it; we do not track upstream, rebase onto it, or merge from it. Upstream is at most mined manually for specific fixes.
- The ported engine lands behind the existing `AgentConnection` seam (`crates/atlas-native-agent`), so the native agent keeps occupying the same slot as an external ACP agent. Whether the seam's interface survives unchanged and where the ported crates sit in the tree is decided by the integration research, not by this ADR.
- The user-facing name becomes **Atlas Agent**; "Cersei" leaves the product and the glossary at cutover.
- **Not changing:** the ACP agent path and the Marketplace-only install rule (ADR-0002); the app-owned thread-metadata store — Atlas Agent's threads live there like every agent's, distinguished only by agent id (ADR-0001); the design language — the ported engine renders in Atlas's existing components.
- **Apache-2.0 obligations are carried in full.** Upstream's LICENSE and NOTICE ("OpenAI Codex, Copyright 2025 OpenAI") ship with Atlas, modified files carry change notices, and the rebrand removes OpenAI/Codex product branding without removing attribution.

## Consequences

- Every bug and every security patch in the ported code is ours forever. Because there is no upstream tracking, security fixes Codex ships will not reach us automatically — accepted, with the obligation to stand up a watch on upstream security advisories.
- Upstream Codex improvements stop flowing at the fork point, and divergence plus rebranding will make any future manual cherry-pick progressively harder — accepted.
- The vendor-patch treadmill ends: the `[patch.crates-io]` overrides for `cersei-*` disappear with the SDK.
- **This decision is reversed if either holds:**
  1. The port completes and users still see dropped connections and broken streaming — proving the engine was never the cause. Known within one release; this is the test that can actually fail.
  2. Owning the code costs more than the team can carry — every bug and security patch in the ported code being ours proves heavier than the team can sustain.
- **Explicitly not a reversal condition:** a better agent SDK appearing. Owning the engine is the point; a better rental does not change it.
