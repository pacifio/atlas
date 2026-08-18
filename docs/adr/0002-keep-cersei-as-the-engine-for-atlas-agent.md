---
status: accepted
---

# Keep Cersei as the engine for Atlas Agent

Atlas Agent's differentiator is a harness that adapts to whatever model the user
brings. We evaluated replacing the Cersei SDK with a hard fork of `codex-core` to
get that, and **rejected it**: we will build the multi-provider wire adapter on
Cersei's existing provider layer and fix Cersei's turn loop in place.

## Why

The case for the fork rested on Codex already having the per-model capability seam
Cersei lacks. Source inspection says otherwise. `WireApi` has one variant; the
second was deliberately removed in a 49-file, 2,931-line deletion. `ToolSpec`'s own
doc comment states it serializes to an OpenAI Responses API tool, and its component
types are named `ResponsesApiTool` — the intermediate representation *is* the wire
format. `build_tool_router` reads no `ModelInfo` fields, and six of the eight
capability gates elsewhere in that file key on OpenAI wire or auth details rather
than model capability. `internal_chat_message_metadata_passthrough` holds three
fixed first-party fields with no catch-all and is **stripped for any provider that
is not OpenAI**, so it cannot carry an Anthropic thinking signature or a Gemini
`thoughtSignature`.

Decisively, `ApplyPatchToolType` has a single `Freeform` variant and any model slug
absent from the bundled eight-model catalog receives `apply_patch_tool_type: None`
— so a non-OpenAI model would get no edit tool at all.

The adapter is therefore net-new work in either codebase. Given that, `codex-core`
sells only a turn loop, context manager, and compaction, priced at ~195k LOC with
no feature flags, no turn cap, a 211-method `Session` type that `approvals.rs` is
44% composed of, and permanent hand-porting of upstream fixes. The turn loop it
would replace is 1,123 lines, already vendored, and sits beside 3,382 lines of
debugged Anthropic, Gemini, and OpenAI-compatible wire handling that Codex has no
equivalent of.

## Consequences

Cersei's known defects become ours to fix rather than to escape: the read-before-edit
guard that reports a rejection after the write has landed, the four vendored patches
of which one has no guard constant, and the absence of any full-turn test.

Which models get the shell-first tier and which get the structured tier is an
empirical question, and the eval that answers it runs **before** adapter work
rather than after.

Codex remains a distinct engine for users with a subscription. Moving it off the
`npx` bridge onto the in-process app-server is a separate, contained improvement;
it does not serve Atlas Agent, because that path is OpenAI-only on the wire.

This is reversible in one direction only: the wire adapters, the structured tool
tier, and the eval matrix are all portable to a different harness later. The fork
would not have been portable back.

## What was built

The tool layer was rebuilt beneath Cersei rather than around a replacement engine:
one gate applied to every registered tool, workspace containment, a read registry,
atomic writes, and the enforcement ladder. Cersei's turn loop, tool registry,
context management and provider layer are unchanged.

Two vendored patches were needed, both recorded with compile-time guard constants
so a `[patch.crates-io]` override that stops applying becomes a build failure
rather than a silent behaviour reversion:

- `tool-cancel-race-v1` (pre-existing) — race tool execution against the cancel
  token, and synthesise paired cancelled `tool_result`s for orphaned `tool_use`
  blocks.
- `tool-result-metadata-v1` (new) — carry `ToolResult::metadata` on the `ToolEnd`
  event, and let a tool return image content. Upstream discards the metadata one
  frame after the tool computes it, which is why every file edit's real
  before/after was lost and the UI had to re-derive a diff from raw tool input.

The wire adapter this ADR anticipated has not been built; the harness spec places
it after the BYOK evaluation matrix, and that ordering still holds.
