# ADR-0001: App-owned thread-metadata store for session history

**Status:** Accepted

**History:** 2026-08-22: accepted; scrape readers replaced by an app-owned store. 2026-10-05: discovery split from replay; ongoing, project-scoped discovery and live-elsewhere guard (ATL-421–424).

## Context

Atlas's session sidebar and history were built by scraping each agent CLI's private storage: Claude's `~/.claude/projects` JSONL, Kilo's SQLite database, Codex's state database, merged with Atlas's own transcript stores and a live ACP `session/list` query (six sources total). This coupled Atlas to storage formats it does not own, required a bespoke reader per agent (special treatment by construction), made history impossible for agents without a reader, and tied Kilo/Codex resume to scraped identifiers. Zed — whose ACP stack Atlas is porting — never reads another program's storage.

The first version of this decision banned reading agent storage outright. That ban lumped two jobs together: **discovery** (knowing a session exists, plus its id, cwd, title, last activity, and whether another process is writing it now) and **replay/resume** (the conversation itself). It was right for replay and arbitrary for discovery, and it never actually held: the checkpoint importer reads `~/.claude/projects` continuously, and the Claude ACP adapter's own `session/list` reads that same directory through the SDK. The sidebar got the same data, slower and only once, and a Claude Code session run in a terminal never reached it.

Primary-source research: `plans/atlas-history-zed-parity-research.md` (Zed's store schema and lifecycle, ACP spec shapes, adapter capability evidence, Atlas consumer inventory).

## Decision

Port Zed's `ThreadMetadataStore` mechanism same-to-same, rendered in Atlas's design language, and keep it current with ongoing, project-scoped discovery.

### The store

- History is an **app-level SQLite store of thread metadata only** (`crates/atlas-thread-metadata`): app-minted thread id, nullable ACP session id for drafts, agent id, title + user override, timestamps, worktree paths, archived flag, remote-connection slot. Transcripts are never stored.
- It also records which agents the first-run backfill has run for, which session ids the user deleted, and confirmed transcript aliases (see *Attribution*). These are app state rather than thread metadata, and live here because they must be as durable as the rows they govern.
- It is the sidebar's and History's **only** source. Every writer goes through it, and its change events (`atlas:threads-changed`) are the sidebar's refresh signal.
- Writers are atomic per row: a read-modify-write happens under the cache's write lock, and the disk write is queued before the lock is released. Imports insert through one call that re-checks session ids under that lock, so racing imports never produce two rows for one session.
- **Resume** selects `session/load` vs `session/resume` by advertised capability. **No agent-identity checks anywhere** — capability flags only (ADR-0002).
- The checkpoint importer's contract (do not relocate or disable the CLIs' own files) is preserved. Atlas never writes to an agent's storage.

### Rules

- **Rule 1 — discovery metadata only.** Atlas may read an agent's on-disk storage for discovery: session id, cwd, last activity (file mtime), liveness. The on-disk provider lists a directory and reads file times; it never opens a transcript.
- **Rule 2 — replay goes through the agent.** Replay and resume always use `session/load` / `session/resume`. Atlas never renders a transcript it read from disk for this purpose.
- **Rule 3 — attribution by `session/list`.** A discovered session belongs to whichever agent lists it over `session/list`, never to a hardcoded agent id. A session id seen on disk is only a reason to ask.
- **Rule 4 — `session/list` is the floor.** Every agent that advertises `sessionCapabilities.list` gets import and project sync. An on-disk provider is an optional upgrade, keyed by storage format, not agent identity. The one provider today watches Claude Code's transcript directory.
- **Rule 5 — discovery is ongoing and scoped to the open project.** See *Discovery*.
- **Rule 6 — local only.** Discovered rows and liveness never enter telemetry and are never drained to the cloud.
- **Rule 7 — no silent fork.** A session that is live elsewhere is never sent to without explicit confirmation, and never deleted. See *Liveness*.

### Discovery

- **Sources.** The live feed of in-app conversations; the user-initiated import and the one-time first-run backfill (both land everything archived); and the **project sync**, which runs when the sidebar is shown for a project, on window focus, and when the watcher sees an unknown session. The sync asks only agents the store already has rows for, so an automatic action never spawns an agent the user has not used. Each agent is bounded by a short timeout, and the sync is debounced per project.
- **One spelling of the project.** The UI's cwd is canonicalised once (`canonicalize`, falling back to the trimmed raw path) before it keys the watcher's directory, the `session/list` cwd filter and the sync debounce. Claude Code names its directory after its physical `getcwd`. The slug is the SDK's exactly: every UTF-16 unit outside `[A-Za-z0-9]` becomes `-`, and a slug over 200 units is cut and suffixed with a base-36 hash of the path.
- **Watcher.** The open project's transcript directory is watched (its parent until it exists), debounced. A known session that moved has its `updated_at` bumped forward. An unknown one forces a sync. The watcher is re-armed per project; a generation counter ensures a superseded arming can never install its watch over a newer one.
- **Recency, not archiving, keeps the sidebar small.** Rows whose activity falls in the last **7 days** land unarchived; older ones land archived. **New activity on an archived row brings it back**: observed activity inside the window and more than 10s past the row's stored `updated_at` unarchives it. That applies to the watcher's file times and to the agent-reported `updated_at` on a sync. An archived row's `updated_at` moves only when it is unarchived, so it stands in for an archived-at time. The slack is what stops the agent's own trailing write from reviving a thread the user archived right after an Atlas turn.
- **Unknown ids back off.** An id on disk that no agent lists is retried per id after 60s, doubling to a 30-minute cap. It is forgotten once the store knows it. The rule never asks which agent should list it.
- **Imported rows carry a start time.** `created_at` is the agent's reported creation time, else the activity time it reported at import. History orders by start, and that order must not move as activity is observed.
- **Atlas's own writes are not discovery.** A write the watcher can put down to an Atlas turn is skipped: no touch, no store write, no refetch. Atlas's live feed already keeps that row current.

### Liveness

A session is **live elsewhere** when its transcript was written within **~90s** (`LIVE_WINDOW`) **and** the write is not explained by Atlas's own turn. A write is explained when an Atlas turn is in flight in that session, or when it lands no more than **5s** after Atlas's last turn there ended. Atlas counts each send in and out (`AgentHost::atlas_activity`).

Having the session open in Atlas does not count. Opening a sidebar row binds the session while a terminal may still be writing it, and that is exactly the fork this guards against.

Liveness is computed, not stored. It rides on each row (`liveElsewhere`). The watcher re-announces `atlas:threads-changed` whenever the live set changes, including when the clock alone moves it (a ticker runs only while something is live).

What Rule 7 holds:

- **Sending.** The composer shows a banner and holds the send until the user picks "Send anyway". The hold sits at the one point every sender passes (`ChatPanel.handleSend`): the composer, suggestion chips, `atlas:chat-send` (agent-switch handoffs, another agent's `ui_chat`), the queue drain and the permission modal. Nothing is dropped. The message queues, or a held first message stays held, and the drain releases it on "Send anyway" or once the session stops being live. An override lasts only while the session stays live.
- **`ui_chat` "send"** to a held session is refused with a reason. The calling agent is told to use `prefill` and leave the choice to the user.
- **Deleting** a live-elsewhere row is refused ("still active in another process; close it there first"). The agent-side delete would remove the transcript under the running process.

### Deletion

Delete is local-first: the row goes regardless of whether an agent is reachable, and agent-side `session/delete` is attempted only when advertised. **Deletes are permanent.** The deleted session id is recorded durably, and every import path (sync, backfill, manual import) and every watcher touch skips it, so an agent that cannot forget a session does not list it back. The owner's confirmed aliases go with it, and each alias id is recorded as deleted too, so the continuation is not imported in the deleted conversation's place. The one exception is honest: a conversation still open in Atlas that the user keeps sending to gets its row written again by the live feed, and that clears the record.

### Attribution when an agent switches transcript files

An adapter may keep one ACP session id while writing the conversation's continuation to a transcript under a fresh id. The Claude adapter does this when plan mode's "clear context" restarts its private conversation, and says nothing on the wire. Taken at face value, the new file is an unknown session: synced in as a terminal row, shown live elsewhere while Atlas is the writer, and, if opened, run by a second agent process on the same file.

Atlas attributes such an id in two steps, from activity and file times alone. No agent id or permission option id is involved.

- **Claim, provisionally.** An id first seen on disk while an Atlas turn is in flight in a session whose own transcript is in the same directory is claimed as that session's alias. The directory is per project and per storage format. A provisional alias carries its owner's activity (its writes are Atlas's) and is excluded from sync and import. It lives in memory only; nothing provisional is ever persisted.
- **Revoke on a stray write.** A real continuation is written only while Atlas drives its owner. So if the alias file is written when the owner has no Atlas turn in flight, and not within 5s of the owner's last turn ending, the alias is dropped. In that same watcher batch the id becomes an unknown session, due a forced sync regardless of its backoff, and liveness is recomputed.
- **Confirm, then persist.** The alias is confirmed when a *later* Atlas turn of its owner (not the one it was claimed in) writes the alias file and leaves the owner's own transcript untouched. A confirmed alias is persisted in the store (`session_aliases`), loaded at open, and from then on counts as known for import and sync, and carries its owner's activity for liveness. Deleting the owner's row removes it, as *Deletion* describes.

The remaining blind spot is narrow: a terminal session started in the same project during an Atlas turn is hidden only until its next write that no Atlas turn explains. Then it appears, with its live dot.

The proper fix is a wire signal from the agent that a session's storage identity changed: an ACP RFD is being drafted, with an interim `_meta` signal from the adapter in the meantime. When an agent sends it, the alias is recorded from the wire and the guess is not needed.

## Consequences

- Any agent gets history, import, resume and delete purely from its advertised capabilities — zero Atlas code per agent.
- Sessions run outside Atlas reach the sidebar for any agent that advertises `session/list`, on the next sync; for an agent with an on-disk provider, within seconds and with liveness.
- Cost/usage coverage stays limited to sessions run through Atlas — accepted. Discovery reads no content, so it cannot widen it.
- Archive is a first-class state, but it is overruled by new activity. A user who wants a session gone for good deletes it.
- Cross-project sidebar grouping is possible because the store is app-level with path-indexed queries.
- Transcript aliases are inferred, provisional until the agent's own writes confirm them, and only confirmed ones are persisted. The inference is a stopgap until the wire signal exists.
