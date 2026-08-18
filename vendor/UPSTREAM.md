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
