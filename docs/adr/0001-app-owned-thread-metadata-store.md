# ADR-0001: App-owned thread-metadata store for session history

**Status:** Accepted (2026-08-22)

## Context

Atlas's session sidebar and history were built by scraping each agent CLI's private storage: Claude's `~/.claude/projects` JSONL, Kilo's SQLite database, Codex's state database, merged with Atlas's own transcript stores and a live ACP `session/list` query (six sources total). This coupled Atlas to storage formats it does not own, required a bespoke reader per agent (special treatment by construction), made history impossible for agents without a reader, and tied Kilo/Codex resume to scraped identifiers. Zed — whose ACP stack Atlas is porting — never reads another program's storage.

Primary-source research: `plans/atlas-history-zed-parity-research.md` (Zed's store schema and lifecycle, ACP spec shapes, adapter capability evidence, Atlas consumer inventory).

## Decision

Port Zed's `ThreadMetadataStore` mechanism same-to-same; render it in Atlas's existing design language.

- History is an **app-level SQLite store of thread metadata only** (app-minted thread id, nullable ACP session id for drafts, agent id, title + user override, timestamps, worktree paths, archived flag, remote-connection slot). Transcripts are never stored; replay comes from the agent via `session/load`.
- The store is fed by **live in-app conversation events** and by **ACP `session/list` import** (user-initiated, plus a one-time automatic first-run backfill). Nothing else feeds it.
- The store also records which agents the **first-run backfill** has already run for. It is app state rather than thread metadata, and it lives here because it must be as durable as the rows it produced.
- **Resume** selects `session/load` vs `session/resume` by advertised capability; **delete** is local-first with agent-side `session/delete` only when advertised. **No agent-identity checks anywhere** — capability flags only.
- All scrape readers, the Claude-dir file watcher, and the live `session/list` sidebar source are deleted. The checkpoint importer's contract (do not relocate or disable the CLIs' own files) is preserved — Atlas stops *reading* CLI storage for UI; it does not touch those files.
- Cost/usage surfaces and past-session mentions re-source from Atlas-recorded data (checkpoint usage records, Atlas transcripts).

Spec: issue #15; tickets #16–#21; staged deletion lands in #14.

## Consequences

- Any registry agent gets history/import/resume/delete purely from its advertised capabilities — zero Atlas code per agent.
- Sessions run outside Atlas (terminal-run CLIs) are visible only via `session/list` import, and only for agents that advertise it. Auto-discovery of arbitrary terminal-run chats is lost — accepted.
- Cost/usage coverage narrows to sessions run through Atlas — accepted.
- Archive is a first-class state; imports land archived. Cross-project sidebar grouping becomes possible because the store is app-level with path-indexed queries.
