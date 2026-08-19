# Vendored crates

Two crates from the Cersei agent SDK are vendored here and applied through
`[patch.crates-io]` in every crate that depends on them. Each local change is a
**patch**: a named, minimal edit to upstream source, recorded below.

Per `CONTEXT.md`'s **Vendor** definition, this file is the record. It exists
because the alternative failure mode is silent: a re-vendor that drops a patch
compiles cleanly and reverts the behaviour, and nobody finds out until the bug
it fixed comes back.

## Pinned upstream

| Crate | Upstream version | Source |
|---|---|---|
| `cersei-agent` | 0.2.6 | crates.io |
| `cersei-provider` | 0.2.6 | crates.io |

Both are vendored at the published 0.2.6 source, unmodified except for the
patches below. To re-vendor: replace the directory with the new published
source, re-apply every patch in the table, and confirm
`cargo test -p atlas-cersei --test vendor_patch_guard --test utf8_patch_guard`
passes.

## Patches

Every patch has a **guard constant** — a `pub const` naming it — referenced from
a compile-time binding in `crates/atlas-cersei/src/lib.rs` and asserted in a
test. If a build resolves the unpatched crates.io release, the constant is
missing and the build fails rather than silently reverting.

| Patch | Guard constant | Files | What it does, and what breaks without it |
|---|---|---|---|
| `incremental-utf8-v1` | `cersei_provider::utf8::ATLAS_UTF8_PATCH` | `cersei-provider/src/utf8.rs` and the SSE decoders | Incremental UTF-8 decoding across HTTP chunk boundaries. Upstream calls `from_utf8_lossy` on each raw chunk, so a multi-byte character split across two chunks is corrupted into replacement characters mid-stream. |
| `tool-cancel-race-v1` | `cersei_agent::ATLAS_CANCEL_PATCH` | `cersei-agent/src/runner.rs` | Races tool execution against the cancel token and synthesises paired cancelled `tool_result`s for orphaned `tool_use` blocks. Without it a running Bash or Edit completes — and its writes land — after the user pressed Stop, and the next turn's request is invalid because a `tool_use` has no matching result. |
| `tool-result-metadata-v1` | `cersei_agent::ATLAS_TOOL_METADATA_PATCH` | `cersei-agent/src/events.rs`, `runner.rs` | Carries `ToolResult::metadata` on the `ToolEnd` event, and lets a tool return image content in its result block. Upstream discards the metadata one frame after the tool computes it, so every file edit's real before/after is lost and the UI is left re-deriving a diff from raw tool input; an image tool has no way to hand the model an image at all. |
| `retry-classified-v1` | `cersei_agent::ATLAS_RETRY_PATCH` | `cersei-agent/src/retry.rs`, `runner.rs`, `events.rs` | Classifies a provider error as transient or permanent and retries only the transient ones, with backoff. Without it a rate limit ends the turn, and a permanently bad key is retried three times before it does. |
| `delegate-fallible-factory` | `cersei_agent::ATLAS_DELEGATE_PATCH` | `cersei-agent/src/delegate.rs` | Makes the delegate's provider factory fallible, so a rebuild error becomes one failed sub-task rendered in its own tool card rather than a panic that aborts the whole parent turn through the actor's supervisor. |
| `steering-queue-v1` | `cersei_agent::ATLAS_STEERING_PATCH` | `cersei-agent/src/lib.rs`, `runner.rs`, `events.rs` | Mid-turn steering: `Agent::steer` (and `AgentControl::InjectMessage`) queue a user message the runner injects at the next tool-batch boundary, and on EndTurn a queued steer keeps the loop alive instead of finishing around it. Without it a send during a live turn can only be rejected or supersede-cancelled. |
| `doom-loop-input-hash-v1` | `cersei_agent::ATLAS_DOOM_LOOP_PATCH` | `cersei-agent/src/runner.rs`, `events.rs` | The doom-loop detector keys on (tool, input-hash) and requires failures; a repeat after the nudge escalates to a permission ask (`DOOM_LOOP_ASK`). Upstream keyed on names alone with no error check, so a healthy Read/Edit alternation tripped it while genuine loops thrashed to the turn cap after one nudge. |
| `max-tokens-guard-v1` | `cersei_agent::ATLAS_MAX_TOKENS_GUARD_PATCH` | `cersei-agent/src/runner.rs`, `lib.rs` | A MaxTokens-stopped message carrying `tool_use` blocks gets paired error `tool_result`s (the calls are never executed — salvage-parsed JSON from a truncated stream validates but lies). Without it the unpaired `tool_use` is an invalid-history API error on the next model call. |
| `pre-compact-hook-v1` | `cersei_agent::ATLAS_PRE_COMPACT_PATCH` | `cersei-agent/src/lib.rs`, `runner.rs` | Auto-compaction awaits an `on_pre_compact` hook with the full message snapshot before summarizing (contract C1 — the memory flush registers here), and emits `CompactStart`/`CompactEnd`, which upstream defined but never emitted — Atlas's read-registry reset listens for `CompactEnd`. |
| `retry-after-v1` | `cersei_provider::ATLAS_RETRY_AFTER_PATCH` | `cersei-provider/src/lib.rs`, `anthropic.rs`, `gemini.rs`, `openai.rs` | Folds the `Retry-After` response header into the SSE error strings as `(retry-after: Ns)`, which the retry classifier parses to pace backoff to the server's answer instead of a guess (429s included, not just overload bodies). |
| `compact-turn-boundary-v1` | `cersei_agent::ATLAS_COMPACT_PATCH` | `cersei-agent/src/compact.rs`, `runner.rs`, `lib.rs` | M4: compaction splits at turn boundaries only (the raw `len − 10` split could orphan a tool_result — an invalid-history API error on Anthropic), keeps a token-budget tail (window/4 clamped 2k–15k) instead of a message count, produces a structured iteratively-updated summary (previous summary handed back for update-in-place), carries the write-class file-op list forward mechanically, counts tool_use/tool_result bytes in token estimates (they were ignored, so tool-heavy sessions never triggered compaction), and snips at the same boundary on summarizer failure. C1 hook and CompactStart/End unchanged. |
| `compact-tool-evidence-v1` | `cersei_agent::ATLAS_COMPACT_EVIDENCE_PATCH` | `cersei-agent/src/compact.rs`, `lib.rs` | The summarizer request renders each message with `message_wire_text` (tool_use inputs and tool_result payloads included) instead of `get_all_text()`, which returns Text blocks only. Without it the living summary's Progress and Errors-and-fixes sections are written from the assistant's prose alone — every build error, file read and command result stripped out — and the model continues on that summary for the rest of the session. Per-message contribution is head/tail-clamped (4k) so one huge result cannot consume the summarizer's own window and drop the call into the snip fallback. |
| `model-profile-v1` | `cersei_agent::ATLAS_MODEL_PROFILE_PATCH` | `cersei-agent/src/lib.rs`, `runner.rs`, `compact.rs` | M2's SDK knobs: a `.context_window(u64)` builder override honored by the auto-compact check (the substring table's unknown-model default of 200k made small models overflow instead of compacting), the builder's `compact_threshold` actually read (it was stored and never consulted), and a `.reasoning_effort(str)` option forwarded to providers that express thinking as an effort level (OpenAI o-series / gpt-5). |

## Two of these are not really engine-specific

`incremental-utf8-v1` and `retry-classified-v1` solve problems any provider
implementation has: decoding a byte stream, and telling a rate limit apart from
a bad key. The harness spec treats them as harness-level concerns rather than
vendor patches going forward — they should move above the engine boundary and
stop being patches at all.

## Not vendored here

The macOS Seatbelt policy data lives with the code that uses it, at
`crates/atlas-cersei/src/tools/sandbox/`, with its own `ATTRIBUTION.md`. It is
data rather than a patched dependency, so it is not in this table.
