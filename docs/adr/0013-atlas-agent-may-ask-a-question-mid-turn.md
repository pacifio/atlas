# ADR-0013: Atlas Agent may ask the user a question mid-turn

**Status:** Accepted (2026-09-26)

## Context

The native seam's standing rule (`crates/atlas-native-agent/src/lib.rs`) is that nothing is asked
of the user mid-turn except tool permission: the connection serves the three approval requests and
answers every other engine request, including `item/tool/requestUserInput` and
`mcpServer/elicitation/request`, with an error. The engine itself ships a first-class
`request_user_input` tool (structured questions with options; the client adds a free-form
"Other") that blocks the turn until answered, and gates it upstream to the Plan collaboration
mode unless the `DefaultModeRequestUserInput` feature is on. Atlas sets neither.

Organisation actions (ADR-0014) make ambiguity routine: "find the comments and solve them" may
match four comments; "send the report to the team" names no channel. Ending the turn with a prose
question and waiting for a new prompt loses the tool results and the plan the model was holding.
The question card that ACP agents' elicitations render on already exists in the chat, above the
composer, in the same place as the permission card.

## Decision

**Atlas Agent may ask a clarifying question mid-turn, through the engine's own tool, in every
mode.** The thread config Atlas builds turns the `DefaultModeRequestUserInput` feature on rather
than patching the fork's mode gate, so nothing under `vendor/atlas-engine` changes. The native
connection serves `item/tool/requestUserInput` by raising it as an elicitation on the thread, and
the existing question card renders and answers it. The turn blocks until the user answers or
dismisses; dismissal is a tool error the model reads, never a hung turn.

**MCP-side elicitation stays refused.** Atlas-offered tool servers return candidates in their
results and the model asks; no tool server talks to the user directly.

## Consequences

- The `lib.rs` rule is narrowed, not dropped: nothing is asked mid-turn except tool permission
  *and a clarifying question the model chose to ask*. Ordinary coding turns gain this too; it is
  not an organisation-only capability.
- A question is a turn-blocking event with a card, so the chat's busy state and the permission
  card's precedence rules apply to it (one card at a time).
- Reversed by dropping the feature flag from the thread config; the seam handler can stay.
- One `mcpServer/elicitation/request` is served, and it is not a tool server talking: the engine
  asks for approval of a prompted MCP tool (ADR-0014's outward actions) as an elicitation it
  originates itself, a form with an empty schema marked `atlas_agent_approval_kind: mcp_tool_call`.
  The seam serves that form only when it names a server Atlas offered the thread (Atlas's servers
  never elicit, so it can only be the engine's), and puts it on the approval card, not the question
  card (`crates/atlas-native-agent/src/engine/tool_approvals.rs`); every other elicitation is still
  refused.
