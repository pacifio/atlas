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
