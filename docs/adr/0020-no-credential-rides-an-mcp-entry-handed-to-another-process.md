# ADR-0020: No credential rides an MCP entry handed to another process

**Status:** Accepted (2026-10-09). Amends ADR-0019 (the bridge now carries every ACP agent, and its token moves from `ATLAS_MCP_TOKEN` to a file) and ADR-0010 / ADR-0015 (an ACP agent that advertises HTTP MCP no longer gets the servers over HTTP).

**For agents:** the rule is `SessionMcpRequest::in_process` in `crates/atlas-agent-servers/src/session_mcp.rs`; the offer is `MemorySessionOffers::offer` in `src-tauri/src/commands/memory_server/offers.rs`; the token files are `TokenFiles` in `src-tauri/src/commands/memory_bridge.rs`; the guarding test is `no_entry_offered_to_another_process_carries_the_token` in `src-tauri/src/commands/memory_server/tests.rs`.

## Context

- Atlas offered `atlas_memory` and `atlas_code` to an ACP agent that advertised `mcpCapabilities.http` as `McpServer::Http`, with the session's bearer token in an `Authorization` header.
- The Claude Agent SDK, under the claude-acp adapter, passes every MCP server it is given to the `claude` CLI as `--mcp-config <json>`, so the token sat in the CLI's argv. Any local user can read argv with `ps`. This was seen live with `ps aux | grep -- --mcp-config`.
- The same SDK writes a stdio server's `env` into that JSON as well (the adapter, `@agentclientprotocol/claude-agent-acp`'s `acp-agent.js`, copies an ACP stdio entry's `env` into the SDK's server config; the SDK serialises the whole map into `--mcp-config`). ADR-0019's bridge kept the token out of the bridge's own argv, but the token still reached the adapter's command line through `env`. Putting the token in a different field does not help.
- What an agent does with its MCP configuration is up to the agent: a command line, a config file, a log. Atlas cannot know, and per ADR-0002 must not guess by agent id.

## Decision

- **Only an agent in the Atlas process is handed a credential in an MCP entry.** `SessionMcpRequest` carries `in_process`, a property of the connection like `ui_control`: the native connection sets it, an ACP connection never does. The native agent keeps HTTP, with the token in the header its engine reads from memory.
- **Every ACP agent gets the servers through the stdio bridge, whatever it advertises.** ACP requires every agent to accept stdio, so no capability is assumed. The entry is `<atlas binary> mcp-bridge <loopback url> <token file>`, with an empty `env`. Every field of it is safe to print.
- **The token lives in a file only the user can read.** Each offer writes its token to a new `0600` file in a `0700` directory of the launch's own, under `<app data>/mcp-bridge/`. Those modes are Unix-only: on Windows the file has no mode of its own and inherits the ACL of the per-user `%APPDATA%` tree it sits in, which only that user (and administrators) can read. The bridge reads the file when it starts, so an agent that relaunches the server reads it again. An offer released unbound deletes its file, and a bound one's goes when its session ends. Each write sweeps this launch's files whose token has been revoked. At startup, off the async runtime, Atlas deletes the directories of launches that have ended and were untouched for seven days (`STALE_LAUNCH`), never a live one: a running launch holds a lock on its directory's `.launch.lock` and refreshes its mtime on every write, because two Atlas processes can run on one data directory (the installed app beside a debug build compiled without `tauri.dev.conf.json`, whose identifier is the release one; the single-instance plugin is release-only). A leftover file is harmless, because tokens live only in Atlas's memory and die with the session or the launch.
- Without the Atlas binary's path (`current_exe` fails), an ACP session gets no Atlas servers and the offer's log line says why. If the token file cannot be written, the session gets none either: the token is revoked unused and a warning is logged. Neither case falls back to HTTP.
- The rule covers every server on the shared token, not only memory and code: an entry goes over HTTP only when the request is `in_process` (and the agent takes HTTP); anything else is bridged. The UI and organisation servers are offered only to a connection carrying `ui_control` / `org_access`, which today only the native one does, so in practice they never ride the bridge; if a future connection carried either without being in process, its entries would be bridged too, not sent with a header.
- The bridge's path is `current_exe()`, which is whichever binary is serving: `target/debug/atlas` under `bun run dev:app`, `Atlas.app/Contents/MacOS/atlas` in a release. `main` runs `run_bridge_if_asked` before anything else, so the bridge never boots a window, a profile or the single-instance plugin.
- `preapproval_meta` pre-approves the host's stdio entries for the Claude Code adapter, as it did its HTTP ones.

## Considered

- **Keep HTTP for ACP agents that advertise it, and move the token elsewhere.** No other field is any safer: the URL, the headers and `env` all land on the command line. A token-less URL with a one-time ticket in argv can be redeemed by whoever reads `ps` first. HTTP would have saved one local process and one loopback hop per call, which costs nothing anyone would notice.
- **The token in the bridge's `env`** (ADR-0019 as written). It is safe from the bridge's own `ps` line but not from the adapter's, as shown above.
- **Choosing per agent** (HTTP for an adapter known to keep its config in memory). Against ADR-0002, and unknowable: an adapter's next release may change it.

## Consequences

- An ACP agent runs one bridge process per offered server per session.
- The log line reads `memory_server=included_via_bridge` for every ACP agent, including one that logs `http_mcp=true`.
- The user's own processes can read the token file. That is the same exposure as `env` (same-user processes can read each other's environment and memory), and the file is closed to other users.
- Windows: the file sits under the user's profile, whose ACL already restricts it. ADR-0019's manual check of the GUI-subsystem bridge launch still applies, and now covers every ACP agent on Windows rather than only stdio-only ones.
