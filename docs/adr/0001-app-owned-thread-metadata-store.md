# ADR-0001: App-owned thread-metadata store for session history

**Status:** Accepted (2026-08-22); amended 2026-10-05 — see "Amendment: discovery is not replay"

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

## Amendment: discovery is not replay (2026-10-05)

The original decision lumped two jobs together: **discovery** (knowing a session exists, plus its id, cwd, title, last activity, and whether it is live now) and **replay/resume** (the conversation itself). The ban on reading agent storage was right for replay and arbitrary for discovery, and it never actually held. The checkpoint importer reads `~/.claude/projects` continuously. The Claude ACP adapter's own `session/list` reads that same directory through the SDK. So the sidebar was getting the same data, slower and only once. The visible cost: a Claude Code session run in a terminal never reached the agent sidebar.

**Rules:**

- **Rule 1.** Atlas may read an agent's on-disk storage for **discovery metadata only**: session id, cwd, title, last activity, liveness. It never reads message content for this purpose.
- **Rule 2.** **Replay and resume always go through the agent** (`session/load` / `session/resume`). Atlas never renders a transcript scraped for this purpose and never writes to those files.
- **Rule 3.** A discovered session is attributed to an agent by that **agent's own `session/list` membership**, never by a hardcoded agent id. ADR-0002 holds.
- **Rule 4.** `session/list` stays the floor every agent gets. An on-disk discovery provider is an optional upgrade, keyed by storage format, not by agent identity.
- **Rule 5.** Import is **ongoing and scoped to the open project**, not one-shot. Sessions active in the last 7 days land unarchived; older ones still land archived. Recency, not archiving, is what keeps the sidebar from flooding. The manual import and the first-run backfill keep landing everything archived.
- **Rule 6.** Discovered rows and liveness are **local only**. They are never in telemetry and never drained to the cloud.
- **Rule 7.** A session whose transcript another process wrote in the last ~90s, and which Atlas is not itself hosting, is **live elsewhere**. Atlas must not silently fork it: sending from Atlas is held behind an explicit confirmation.

Tickets: ATL-422, ATL-423, ATL-424.

## Consequences

- Any registry agent gets history/import/resume/delete purely from its advertised capabilities — zero Atlas code per agent.
- Sessions run outside Atlas (terminal-run CLIs) are visible only via `session/list` import, and only for agents that advertise it. Auto-discovery of arbitrary terminal-run chats is lost — accepted. *(Superseded by the 2026-10-05 amendment: discovery through on-disk storage is now permitted.)*
- Cost/usage coverage narrows to sessions run through Atlas — accepted.
- Archive is a first-class state; imports land archived. *(Superseded by the 2026-10-05 amendment: ongoing discovery lands sessions unarchived if active in the last 7 days; manual import and first-run backfill still land archived.)* Cross-project sidebar grouping becomes possible because the store is app-level with path-indexed queries.
- An agent with an on-disk discovery provider gets live session discovery; any other agent still gets `session/list` import.
