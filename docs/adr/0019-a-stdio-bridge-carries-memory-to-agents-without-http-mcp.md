# ADR-0019: A stdio bridge carries memory to agents without HTTP MCP

**Status:** Accepted (2026-10-07). Milestone M4 of `docs/superpowers/plans/2026-10-03-memory-system/`. Amends ADR-0010's "an ACP agent that does not advertise HTTP MCP gets no memory at all". Amended by ADR-0020: the bridge now carries every ACP agent, and the token moved from `ATLAS_MCP_TOKEN` to a private file, because an adapter may put a stdio entry's `env` on its own command line.

**For agents:** the bridge is `src-tauri/src/commands/memory_bridge.rs`; the offer is `OfferDecision::IncludedViaBridge` in `src-tauri/src/commands/memory_server/offers.rs`; the dispatch is `run_bridge_if_asked` in `src-tauri/src/lib.rs`, called first in `main.rs`.

## Context

- ADR-0010 made memory something an agent pulls through Atlas's MCP tool server, served over streamable HTTP on loopback, and accepted that an agent without HTTP MCP gets no memory. None was in use then.
- Switching between agents in one repository is the primary memory scenario (memory plan decision 4, 2026-10-03). An agent that cannot reach the tool server starts every switch with nothing: no briefing, no handoff note, no `memory_why`.
- ACP requires every agent to accept stdio MCP servers; only HTTP and SSE are optional capabilities (`admissible` in `crates/atlas-agent-servers/src/session_mcp.rs` always admits a stdio entry).

## Decision

- An agent that does not advertise `mcpCapabilities.http` is offered `atlas_memory` (and `atlas_code`, when the code tools are on) as a **stdio** server whose command is the Atlas binary itself: `<current exe> mcp-bridge <loopback url>`.
- The bridge reads one JSON-RPC message per line from stdin, POSTs it to the loopback server with the session's bearer token, the MCP session id once the server has issued one and the protocol version `initialize` negotiated, and writes every message of the answer (a JSON body or each SSE `data:` line) back as one line, whatever the HTTP status. A JSON-RPC error goes back to the agent instead of ending the bridge.
- When the server no longer knows the session (a 404 that is not JSON-RPC), the bridge replays the agent's `initialize` and `notifications/initialized`, takes the new session id and retries the request once. The memory and code servers also keep idle sessions (no keep-alive timeout), so an agent that goes quiet for a while keeps its tools.
- The token is passed in the environment variable `ATLAS_MCP_TOKEN`, never in argv (argv is visible to other users through `ps`). It is minted, bound and revoked exactly as for an HTTP offer, and it is the same one token for every server the session is offered.
- The bridge refuses any URL that is not plain `http` to `localhost` or a loopback IP, and any URL with userinfo (`http://127.0.0.1:1@example.com` is refused). It ignores `HTTP_PROXY` and `HTTPS_PROXY`: loopback traffic never goes through a proxy.
- The UI and organisation servers stay HTTP-only: they are offered only to connections that ask for them.

## Consequences

- One extra process per such session, living as long as the agent keeps the MCP server.
- Nothing changes for HTTP agents or the native agent.
- Server-initiated messages (the GET stream) are not forwarded; the memory tools never send any.
- The release binary on Windows is a GUI-subsystem executable. Piped stdio handles from the launching agent still work because no console is needed, but this path needs a manual check on Windows: the in-process bridge test covers the forwarding, not the subprocess launch.
