# ADR-0010: Shared memory reaches an agent only through the memory tool server

**Status:** Accepted (2026-09-21). Branch `feat/shared-memory-unification`, after spec #77's thirteen tickets landed. Amended by ADR-0020: an ACP agent gets the server through the stdio bridge whatever it advertises; only the in-process native agent gets it over HTTP.

**For agents:** this supersedes the "Push" row of `docs/research/shared-memory-system.md` § "Outcome in one page" and rounds 2–3 decisions Q14, Q4 (reopened) and Q15 there. Nothing is prepended to a prompt any more. If a regression is traced to memory not reaching an agent, look at the tool server (`src-tauri/src/commands/memory_server/`) and its instructions, not at `agents_send`.

## Context

Until now memory reached an agent two ways at once:

1. **Push.** `agents_send` composed an `<atlas-memory>` envelope in front of the user's words: on a session's first send a briefing (working memory, a ranked durable index, the curated pack from foreign memory files, the previous session's tail), on later turns the delta by a per-session sync clock, and on every turn a retrieval-augmented block for the user's message.
2. **Pull.** The in-process MCP memory tool server (#82, #83), handed to every agent that advertises HTTP MCP, with four tools: `memory_search`, `memory_remember`, `memory_forget`, `memory_list`.

Two paths meant two truths. The push path had to guess what a turn needed, paid its cost on every send (retrieval before the agent could start, a hard 6 s + 8 s budget), moved slash commands off byte 0 unless special-cased, echoed Atlas's own text back through agents' transcripts (the pollution loop #78 had to fix at every reader), and made the sync clock a property of the send path rather than of the agent's session. The pull path was the better mechanism but under-specified: an agent had no way to ask for "what the prompt used to carry" and nothing told it to look first.

The runtime check #79 left open is answered: both agents in use advertise HTTP MCP (`http_mcp=true` for Atlas Agent and Claude Code in the 2026-09-21 log), and both surface an MCP server's `instructions` to the model — Claude Code as "MCP Server Instructions", the engine as the description of the tool namespace (`codex-mcp/src/rmcp_client.rs`, `regular_mcp_tool_info_from_listed_tool`).

## Decision

**One way: the agent pulls.** `agents_send` sends the user's text exactly as typed. It keeps only the write half of memory: registering the session so its deltas are captured.

**The tool server is organised as a protocol, read tools first, write tools last:**

| tool | what it answers |
|------|-----------------|
| `memory_briefing()` | what the first send used to carry: the active plan, files changed newest first, the ranked durable index (capped lines), the curated pack (`projectMemory`) and the previous session's tail (`recentSession`). Sets the session's clock. |
| `memory_changes()` | what *other* sessions wrote or edited since this session last looked (its briefing or its last call here). The session's own writes are left out. |
| `memory_search(query, kinds?, limit?)` | the record plus the project's indexed documents — what the per-turn retrieval block searched. |
| `memory_get(id)` | one entry in full; expands an index line. |
| `memory_list(kind?, limit?)` | the newest entries. |
| `memory_remember(kind, content, key?)` | a durable memory (unchanged). |
| `memory_forget(id)` | delete one entry (unchanged). |

**The server's `instructions` carry the protocol** (`memory_server::INSTRUCTIONS`): call `memory_briefing` first in a session; `memory_search` before asking the user about history or repeating an approach that may have failed; `memory_changes` when resuming; `memory_remember` when deciding, learning, failing or mapping the system; never copy results into the agent's own memory files. With nothing pushed, this text is what makes memory reach the model, so it is tested as part of the surface.

**The per-session clock moves into the server** (`SessionClocks`, keyed by session id, the newest `updated_at` the session has seen), set by a briefing or a changes call and dropped when the session ends through the same lifecycle hook that revokes the token.

**The module is split by concern:** `memory_server/{mod, tokens, host, offers, tools, briefing, tests}.rs`. The first-look extras stay app-owned (`agents.rs::build_bootstrap`, within an 8 s budget) and reach the server through a `Sources::bootstrap` seam, like the index already did.

## Consequences

- **Deleted:** `memory_briefing.rs`, `memory_inject.rs`, the envelope composer and slash-command guard in `memory_pack.rs`, the retrieval block composer in `memory_retrieve.rs`, and the first-send / sync-clock / dedup state in `MemorySharingState`. Roughly 2,000 lines of push machinery and their budget tests.
- **Kept:** the `<atlas-memory>` envelope constants and every reader's strip (`atlas_agent_transcript::strip_injected_context`, the frontend `stripInjectedContext`). Transcripts and memory files written while Atlas pushed still carry the envelope, and readers must keep taking it off.
- **Capability drift, accepted by the user (2026-09-21), reversing #77's "no capability lost" constraint for the read side:** an agent that never calls a tool gets no memory. Per-turn retrieval no longer happens on its own; it happens when the agent calls `memory_search`. An ACP agent that does not advertise HTTP MCP gets no memory at all (none in use today; a stdio bridge stays the out-of-scope follow-up).
- **The native agent's turn now depends on its MCP servers being up.** The bounded wait for host MCP servers before a turn (`EngineSessions::wait_for_mcp_servers`, 5 s) went from a nicety to the thing that makes the first prompt see memory.
- The sharing toggle still gates everything: with it off, no server is offered, reads answer empty, writes are refused.
- Nothing about the store, the kinds, capture, the extractor, promotion, imports or the Memory panel changes.
