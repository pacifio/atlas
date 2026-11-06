# ADR-0017: Shared memory's revisions are canonical; everything else is a projection

**Status:** Accepted (2026-10-07). Milestone M1 of `docs/superpowers/plans/2026-10-03-memory-system/`.

**For agents:** if you are changing how shared memory is written, read `crates/atlas-memory/src/record.rs` (`after_write`, `before_delete`, `remember_guarded`, the v5 migration) first. Every write appends a revision; nothing but `clear` and `purge` deletes one.

## Context

Until v4 the record store kept one mutable row per memory:

- a keyed `memory_remember` overwrote another writer's entry in place, so the wording it replaced was lost and the first writer never heard about it (research defect D3);
- an entry's vector was stored by entry id, so a replace that could not be embedded kept a vector of the old words, and a fold could leave vectors for entries that no longer existed;
- the corpus index lived in three files written one after another (`hnsw.usearch`, `manifest.json`, `docstore.json`). A crash between them, or a torn index, left a manifest claiming documents the index no longer held, and retrieval stayed silently empty until the corpus changed;
- nothing could tell a hand edit of `memory.sqlite` from a real write, and a forgotten secret survived in the event log.

Agents switching between Claude Code, Codex and the native agent all write into this one record, so a lost or silently replaced memory is the failure the user feels.

## Decision

- **Immutable revisions are canonical.** Every write to an entry (insert, replace, merge, edit, fold, import, forget, and later archive, promote, feedback, rewind) appends one row to `revisions` holding the entry as it then stood and who wrote it. `entries` is the current view and can be rebuilt from the revisions (`rebuild_entries_from_revisions`).
- **A stale or foreign writer is refused, never silently overwritten.** An agent's keyed write replaces an entry only when it passes the entry's current revision as `expected_revision`, or when the entry's last writer is the same agent **in the same session**. A parallel session of the same agent (another worktree) is another writer. The refusal names the revision and tells the agent to read both versions and write one that keeps what is still true.
- **Projections are rebuilt from canonical data.** `entries_fts` (BM25) is rewritten in the same transaction as its entry. Vectors are cached by `(model, text)` in `embed_cache`, so a vector can never describe text it was not computed from, and switching back to an earlier model re-embeds nothing. The corpus index is `corpus.sqlite` plus a per-model vector file that is rebuilt from the cache whenever it is missing, torn or out of step, without the model.
- **Only `clear` and `purge` delete revisions.** `clear` is the user's confirmed wipe. `purge` erases a forgotten secret from the revisions, the event log and the vector cache, with SQLite's secure delete on and the WAL truncated, and leaves one textless `purge` marker. A test counts the statements that delete revisions.
- **Revisions are sealed into a hash chain.** Each revision's `chain` is blake3 of the previous revision's chain and this row's columns. The chain is unkeyed: it catches hand edits, `sqlite3` one-liners and scripts that write rows directly, not a tool that recomputes it. Purge re-seals from the first revision it removed. The reconciler (M2) reports a broken chain and never rebuilds the view from edited history until the user accepts it.

## Consequences

- One corpus re-embed on upgrade: the old corpus files are derived and are deleted on first open.
- `uses`, `last_used_at` and the event sequence are not revisioned; a rebuild restores content, kind, key, state, confidence and provenance, not usage counters.
- The record's retrieval core is `crates/atlas-retrieval` (cache keys, the f16 codec, the healing vector file, RRF). It was shared with the code index until ADR-0021 removed that; memory is its only consumer now.
- Every later write path (expiry, feedback, dream proposals) goes through `after_write`, so it is revisioned and sealed without further work.
- The reconciler (M2) is built on this: every repair rebuilds a projection from canonical data.
