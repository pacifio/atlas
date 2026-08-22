# ADR-0002: No default ACP agents — the Marketplace is the only way one exists

**Status:** Accepted (2026-08-23)

Cited in code as **§D12-3** (its decision number in the Zed-port research). Prefer citing this ADR.

## Context

Atlas used to ship a table of first-party external agents (`BUILTIN_AGENTS`: Claude Code, Codex, OpenCode, Cursor, Kilo). They appeared in the agent picker on a fresh install, were spawned from a five-rung ladder that could download or `npx`-fetch them on demand, and three of them could be switched off again in Settings. That produced a `builtin` agent kind, an `optional`/`disabled` pair, a `disabledBuiltinAgents` setting, and per-agent tables for login arguments and history readers — special treatment by construction, and a fresh install that started subprocesses for agents nobody had asked for.

Zed, whose ACP stack Atlas is porting, has none of this. Its default settings ship `"agent_servers": {}` (`assets/settings/default.json:2800`), and `AgentServerStore::reregister_agents` (`project/src/agent_server_store.rs:294-489`) rebuilds the runnable set **exclusively from that settings map**. A registry entry with no settings entry is never registered. Its new-thread picker shows the native agent, plus an "External Agents" section rendered only when the map is non-empty (`agent_ui/src/agent_panel.rs:5904-5914`).

Primary-source research: `plans/atlas-acp-zed-port-research.md` §A3 and §D12-3.

## Decision

Copy Zed's mechanism, and be stricter on its one delta.

- **An agent exists iff it has an entry in the installed-agents map.** Installing writes one entry; uninstalling removes it. There is no other source of runnable agents.
- **A fresh install offers exactly the native agent (Cersei).** No ACP agent is pre-seeded, pre-warmed, suggested, or spawned. Zed keeps one promotion surface — a first-run "Agent Setup" grid of four featured registry ids (`crates/onboarding/src/basics_page.rs:539-540`); Atlas ships no equivalent.
- **A detection is an affordance, not a spawn rung.** An agent found on the user's `PATH` is offered, never run: accepting it is a user action that writes a `custom` installed-map entry pointing at their binary. Finding a binary installs nothing.
- **Nothing is optional-and-switchable.** The way to remove an agent is to uninstall it. `builtin`/`optional`/`disabled`/`autoManaged` leave the catalog wire, and the `disabledBuiltinAgents` setting is retired.

## Consequences

- Every agent surface is catalog-derived. The agent picker is the native agent plus installed externals; no static list backs it.
- A user who relied on a built-in must install it once from the Marketplace. Their chat history is untouched — historical rows still render the agent's name and icon from retained registry metadata.
- An older `state.json` naming `disabledBuiltinAgents` still loads; the key is ignored.
- No fresh install spawns a subprocess before the user asks for one.
