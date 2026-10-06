# ADR-0015: Code search is served by the `atlas_code` tool server

**Status:** Accepted (2026-10-03). Phase 1 of `docs/superpowers/plans/2026-10-03-codeindex-search/`.

**For agents:** if an agent cannot search code, or searches the wrong place, look at the code tool
server (`src-tauri/src/commands/code_server/`) and the engine it calls (`crates/atlas-search`),
not at the shell or the prompts.

## Context

Atlas Agent had no search tool of its own. Its bundled prompts told it to run `rg` through the
shell, and Atlas does not bundle ripgrep, so search depended on the user's `PATH`. Every search
paid a process spawn, a sandbox setup and the shell's approval path. The output was raw `rg` text,
middle-truncated at the model's 10k-token limit, which drops the middle of a grep result: the worst
place to cut it. ACP agents bring their own tools (Claude Code bundles `rg`), but nothing Atlas
offered them could search code either: `memory_search` returns whole-file summaries with no line
numbers. The research behind this decision is `docs/research/codeindex-search/` (README and
report 05).

Two seams could carry a search tool. The vendored engine has a `ToolContributor` seam for
extension tools. It is native-only, it would put Atlas code on the engine side of the ADR-0004
boundary, and whether its tools reach `code_mode_only` models is unverified. The in-process MCP
tool server is the route ADR-0010 established and ADR-0012 and ADR-0014 extended: a loopback HTTP
service the host offers each session, whose tools the engine projects as auto-approved and kept out
of the deferred surface (`engine/mcp.rs`). It reaches every agent that advertises HTTP MCP.

## Decision

**A fourth MCP service, `atlas_code`, mounted at `/code` on the memory tool server's listener,
behind the same token middleware and the same per-session bearer token.** One token per session is
what lets several Atlas services coexist; a separately minted token would revoke the others.

**Two read-only tools in this phase, `grep` and `find_files`**, served by a new Tauri-free crate,
`crates/atlas-search`, which embeds ripgrep's own crates (`grep-searcher`, `grep-regex`, `ignore`)
in-process. Later phases add symbol, graph and semantic tools to the same server. Every tool
answers in one compact, byte-budgeted output contract (`atlas_search::compact`): the count first,
rows best-first, whole rows dropped to fit, and honest paging (`total`, `next_offset`,
`truncation`) on every reply.

**Offered to every agent that speaks HTTP MCP, gated by its own setting.** "Let agents search code
with Atlas" (`agentCodeTools`, default on) gates the offer for new sessions and every call in
running ones. The shared-memory toggle does not gate it, because code search reads only the
working tree and stores nothing. Nothing branches on agent identity.

**Scoped to the session's launch directory** (`Grant::cwd`). A path that resolves outside it
(`../`, an absolute path elsewhere, a symlink out) is refused. Symlinks are not followed. Secret
files (`.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`) are
hidden unless a call names the file as its `path`. VCS directories are never searched.

**Bounded.** Each call runs on a blocking thread under a 15 s deadline and returns what it found,
marked partial. It stops within a file when the client cancels or the call's future is dropped,
and it stops walking after 10,000 matching lines. Files are never memory-mapped, because an agent
truncating a mapped file would SIGBUS the whole app. Binary files are skipped, lines are clipped to
300 characters, and files over 10 MiB are skipped and counted.

**The native agent's prompts are reworded to prefer these tools.** Shell `rg` stays allowed for
what they cannot express (look-around, backreferences, replacements, pipes). `rg` calls are not
intercepted.

**The project search overlay runs on the same engine** (`code_grep`, replacing `search_in_files`),
so the user and the agents get the same matches.

## Consequences

- Search no longer depends on `rg` being installed, and needs no approval prompt in any mode.
- Claude Code asked before every call to it until the session request carried the offered servers
  as pre-approved: `_meta.claudeCode.options.allowedTools` (`mcp__<server>`), which its ACP adapter
  passes to the Agent SDK. That is the native agent's standing for the same servers. An ACP session
  is offered no server with ask-first tools, so nothing outward is pre-approved. Other ACP adapters
  ignore the key, and their own permission rules still apply.
- Every session's fixed prefix carries two more tool schemas and the server instructions: about
  3.1 KB (2.6 KB of schema, 0.5 KB of instructions) for the native agent, and the same for ACP
  agents that take the server.
- ACP agents that bundle their own grep (Claude Code) see two search tools. The server
  instructions say when to prefer this one. Neither is disabled.
- Atlas's search is read-only and confined to the session directory, so auto-approval adds no new
  power. It does bypass the shell sandbox's read rules: in-process reads are confined by the root
  check and the deny list instead, and the deny list is the thing to extend when a new secret shape
  appears.
- `code_mode_only` models reach the tools from inside code mode's `exec`, because the projection
  keeps them `Direct`. This is pinned by `the_code_tools_stay_reachable_from_code_mode`. The
  shipped gateway rows set no tool mode, so they call the tools directly.
- Reversed if the engine's extension seam proves better for the native agent, for example
  per-environment remote file systems. In that case the engine adapter calls the same
  `atlas_search` functions, and ACP agents keep the MCP server.
