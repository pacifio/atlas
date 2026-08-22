# Atlas — Context

Glossary of domain terms as this project uses them. Decisions with lasting consequences live in `docs/adr/`.

## Session history domain

- **Thread** — one conversation as Atlas tracks it, keyed by an app-minted thread id. A thread exists independently of any agent process.
- **Draft** — a thread before its first sent message; it has no ACP session id yet. Drafts never create agent sessions.
- **Session** — the agent-side conversation, identified by an ACP session id. A thread references at most one session.
- **Thread-metadata store** — the app-level SQLite store that is the *only* source for the session sidebar and history. Holds metadata only (ids, agent, titles, timestamps, worktree paths, archived flag) — never transcript content. See ADR-0001.
- **Archive** — a first-class thread state: out of the active sidebar, kept in history. Opening an archived thread unarchives it. Imported threads land archived.
- **Import** — user-initiated pull of an agent's sessions into the store via ACP `session/list`; metadata only; capability-gated; deduped by session id.
- **Backfill** — the one-time automatic import pass per installed agent on first launch after the history model shipped.
- **Resume** — turning a history row into a live session through the protocol: `session/load` (replays transcript) or `session/resume` (no replay, user notified), selected by advertised capability.
- **Capability gating** — every per-agent behavior is decided by the capabilities the agent advertised at `initialize`; agent-identity checks are forbidden. ("No ACP agent gets special treatment.")
- **Atlas-recorded usage** — the token totals Atlas's own recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map Atlas caches. The only source for the usage widget, the usage panel and Mission Control; covers sessions run through Atlas and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what Atlas records per session.
- **Scrape readers** *(deprecated)* — the deleted per-agent readers of CLI private storage (Claude JSONL, Kilo DB, Codex state DB). Do not reintroduce.

## Adjacent subsystems

- **Cersei** — Atlas's native agent. Its threads live in the same thread-metadata store as external agents', distinguished only by agent id.
- **Timeline / checkpoint** — the per-workspace observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
