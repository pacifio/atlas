# Atlas — Context

Glossary of domain terms as this project uses them. Decisions with lasting consequences live in `docs/adr/`.

## Session history domain

- **Thread** — one conversation as Atlas tracks it, keyed by an app-minted thread id. A thread exists independently of any agent process.
- **Draft** — a thread before its first sent message. Its ACP session id is never recorded, because the session is re-created whenever the chat is reopened and the id would be stale. A draft is visible while its chat is open and is removed when the chat closes unsent, so abandoned chats leave no history. *(Divergence from Zed, and from this ADR's original wording "drafts never create agent sessions": Atlas's chat panel opens an agent session when the tab mounts, so a draft usually does have a live session — just not a recorded one. Making that lazy is a chat-panel change, not a history one.)*
- **Session** — the agent-side conversation, identified by an ACP session id. A thread references at most one session.
- **Thread-metadata store** — the app-level SQLite store that is the *only* source for the session sidebar and history. Holds metadata only (ids, agent, titles, timestamps, worktree paths, archived flag) — never transcript content. See ADR-0001.
- **Archive** — a first-class thread state: out of the active sidebar, kept in history. Opening an archived thread unarchives it. Imported threads land archived.
- **Live thread feed** — the path that keeps a thread's store row current from the running conversation's own events (`ThreadRecorder`). The only writer besides import. Distinct from the *capture recorder* (`atlas-checkpoint`), which records the transcript and the usage.
- **Import** — user-initiated pull of an agent's sessions into the store via ACP `session/list`; metadata only; capability-gated; deduped by session id.
- **Backfill** — the one-time automatic import pass per installed agent on first launch after the history model shipped.
- **Resume** — turning a history row into a live session through the protocol: `session/load` (replays transcript) or `session/resume` (no replay, user notified), selected by advertised capability.
- **Capability gating** — every per-agent behavior is decided by the capabilities the agent advertised at `initialize`; agent-identity checks are forbidden. ("No ACP agent gets special treatment.")
- **Atlas-recorded usage** — the token totals Atlas's capture recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map Atlas caches. The only source for the usage widget, the usage panel and Mission Control; covers sessions run through Atlas and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what Atlas records per session.
- **Scrape readers** *(deleted)* — the per-agent readers of CLI private storage that used to build session history: Claude's `~/.claude/projects` JSONL, Kilo's SQLite, Codex's state DB, the Claude-directory watcher, and the JSONL replay behind the fast transcript paint. All gone; do not reintroduce. Reads of those directories that deliberately remain, none of them session history:
  - the **checkpoint importer**, whose contract is preserved verbatim;
  - the **memory corpus** and **skills** surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills, per-project memory notes) as documents;
  - the Memory panel's **Codex thread list**, which still queries `~/.codex/state_*.sqlite`. This one is a genuine exception rather than a category difference — it is a session list, read from another program's database, rendered as UI. It survived the history port because it belongs to the Memory panel rather than to the ACP stack. Flagged, not endorsed.

## Adjacent subsystems

- **Cersei** — Atlas's native agent. Its threads live in the same thread-metadata store as external agents', distinguished only by agent id.
- **Timeline / checkpoint** — the per-workspace observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
- **Installed-agents map** — the one record of which ACP agents exist. Installing writes an entry, uninstalling removes it, and nothing else makes an agent runnable. A fresh install has an empty map and offers only Cersei. See ADR-0002.
- **Detection** — an agent found on the user's `PATH` that Atlas has *not* installed. An offer, never a spawn candidate: **accepting a detection** is a user action that writes an installed-agents-map entry pointing at their own binary, downloading nothing. Finding a binary installs nothing by itself.
