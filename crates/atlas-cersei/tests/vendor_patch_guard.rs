//! Compile-time proof that the vendored `cersei-agent` patches are in the build.
//!
//! Both patches are invisible at runtime until something silently regresses:
//! a `[patch.crates-io]` override that stops applying resolves the published
//! crate, everything still compiles, and the behaviour quietly reverts.
//! Referencing the guard constants makes that a build failure instead.
//!
//! Companion to `utf8_patch_guard.rs`, which does the same for `cersei-provider`.

/// The runner races tool execution against the cancel token and synthesises
/// paired cancelled `tool_result`s for orphaned `tool_use` blocks. Without it a
/// running Bash or Edit completes — and its writes land — after Stop.
#[test]
fn vendored_cancel_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_CANCEL_PATCH, "tool-cancel-race-v1");
}

/// `ToolEnd` carries `ToolResult::metadata`. Without it every file edit's real
/// before/after is discarded one frame after being computed, file-change counts
/// read zero with nothing erroring, and the image tool has no way to hand the
/// model an image at all.
#[test]
fn vendored_tool_metadata_patch_is_resolved() {
    assert_eq!(
        cersei_agent::ATLAS_TOOL_METADATA_PATCH,
        "tool-result-metadata-v1"
    );
}

/// Provider errors are classified before being retried. Without it a rate limit
/// ends the turn, and a permanently bad key is retried three times before it
/// does.
#[test]
fn vendored_retry_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_RETRY_PATCH, "retry-classified-v1");
}

/// The delegate's provider factory is fallible. Without it a rebuild error is a
/// panic that takes the whole parent turn down through the actor's supervisor,
/// rather than one failed sub-task rendered in its own tool card.
#[test]
fn vendored_delegate_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_DELEGATE_PATCH, "delegate-fallible-factory");
}

/// A send during a live turn steers it (injected at the tool-batch boundary)
/// instead of being rejected. Without it mid-run course-correction requires
/// cancelling the turn.
#[test]
fn vendored_steering_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_STEERING_PATCH, "steering-queue-v1");
}

/// The doom-loop detector keys on (tool, input-hash) and requires failures,
/// escalating to a permission ask on a repeat. Without it healthy Read/Edit
/// alternation trips a false nudge and genuine loops thrash to the turn cap.
#[test]
fn vendored_doom_loop_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_DOOM_LOOP_PATCH, "doom-loop-input-hash-v1");
}

/// A MaxTokens stop that carries tool_use blocks fails them closed with paired
/// error tool_results. Without it unpaired tool_use in history is an API error
/// on the next model call.
#[test]
fn vendored_max_tokens_guard_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_MAX_TOKENS_GUARD_PATCH, "max-tokens-guard-v1");
}

/// Auto-compaction fires the pre-compact hook (contract C1 — the memory
/// flush) and emits CompactStart/CompactEnd, which upstream defined but never
/// emitted — Atlas's read-registry reset listens for CompactEnd.
#[test]
fn vendored_pre_compact_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_PRE_COMPACT_PATCH, "pre-compact-hook-v1");
}

/// The provider folds the `Retry-After` header into its SSE error strings so
/// the retry classifier can pace backoff to the server's answer.
#[test]
fn vendored_retry_after_patch_is_resolved() {
    // Referenced as `cersei_provider::…` directly, matching utf8_patch_guard
    // and the UPSTREAM.md table (the lib guard goes through the
    // `cersei::provider` facade re-export because the lib has no direct
    // cersei-provider dependency).
    assert_eq!(cersei_provider::ATLAS_RETRY_AFTER_PATCH, "retry-after-v1");
}

/// M2 ModelProfile's SDK-side knobs: a `context_window` override for
/// compaction (the substring table's unknown-model default of 200k made
/// small models overflow instead of compacting), the builder's
/// `compact_threshold` actually honored, and `reasoning_effort` forwarded
/// to effort-style thinking providers.
#[test]
fn vendored_model_profile_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_MODEL_PROFILE_PATCH, "model-profile-v1");
}

/// M4's compaction rewrite: turn-boundary splits (never orphan a
/// tool_result), a token-budget tail instead of "last 10 messages", a
/// structured iteratively-updated summary with mechanical file-op
/// carryover, wire-true token accounting, and a snip fallback that cuts at
/// the same boundary.
#[test]
fn vendored_compact_patch_is_resolved() {
    assert_eq!(cersei_agent::ATLAS_COMPACT_PATCH, "compact-turn-boundary-v1");
}

/// The summarizer reads each message's wire text (tool_use inputs and
/// tool_result payloads included) rather than `get_all_text()`. Without it
/// the living summary is written from assistant prose alone — every build
/// error, file read and command result stripped out — and the model then
/// continues on that summary for the rest of the session.
#[test]
fn vendored_compact_evidence_patch_is_resolved() {
    assert_eq!(
        cersei_agent::ATLAS_COMPACT_EVIDENCE_PATCH,
        "compact-tool-evidence-v1"
    );
}
