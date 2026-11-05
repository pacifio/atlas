# `atlas-memory` — Migration & Operations

How Atlas's RAG/memory moved from the in-Tauri **brute-force O(n) cosine** over a
flat `memory-index/index.json` to the on-device **MiniLM → usearch HNSW** engine
in this crate (the grafeo graph that briefly sat beside it was removed in #89).
Covers the on-disk layout, the legacy migration, the feature flags, the
retained rollback fallbacks, and the **manual** 3-agent runtime verification.

Background: the originating plan and seam spec lived under the old native-agent SDK path
and were deleted with it (#54). The seam as it stands today is below.

> **The seam.** Every agent retrieves through `memory_retrieve::retrieve(app,
> cwd, query, limit)` in `src-tauri`, which takes **no agent-type parameter**,
> so the path is agent-agnostic by construction. The native agent reaches it
> through its `search_memory` dynamic tool (the `MemorySearch` callback
> installed with `atlas_native_agent::engine::memory::register_search`, returning
> `MemDoc { title, source, text }`); every agent, ACP agents included, reaches
> the indexed documents through the memory MCP server's `memory_search` tool
> when memory sharing is enabled for the project. `atlas-memory` has **no
> Tauri** dependency and depends on no agent crate.

---

## 1. On-disk layout

### Per-project — `<project>/.atlas/memory/`

| Path | Written by | Purpose |
|---|---|---|
| `corpus.sqlite` | `corpus::CorpusIndex` | The corpus index (M1): docs, BM25 rows and the `(model, text)` embedding cache. Replaces `hnsw.usearch` + `manifest.json` + `docstore.json`, which are deleted on first open (derived; the corpus is embedded again once). |
| `corpus.<model>.usearch` | `atlas_retrieval::VectorFile` | One model's vectors, rebuilt from the cache when missing, torn or out of step. Switching back to an earlier model re-embeds nothing. |
| `memory.snapshot.sqlite` | `RecordStore::snapshot_if_due` | The record's daily snapshot (M2). |
| `memory.sqlite.corrupt-<ms>` | `RecordStore::open` | A damaged record set aside (M2); the snapshot is restored in its place. |
| `extracted/*.md` | older versions | Legacy per-session extraction output, no longer written: folded into the record store once (see `.record-store-migrated` below). |
| `memory.sqlite` (+ `-wal`, `-shm`) | `record::RecordStore` | The shared-memory **record store** (#80): `events`, `entries`, `sessions`, WAL; since schema v5 (M1) `revisions` (canonical, hash-chained), `entries_fts`, `embed_cache`; since v6 (M4) `links`, `episodes`, `feedback`, `dreams`, `dream_proposals`; since v7 the indexes `entries_kind_updated` and `links_b`, which serve the briefing's per-kind listing and citation link lookups (both were table scans). Each migration is one transaction: v5 gives every live entry a `baseline` revision and moves stored vectors into the cache. Lives only at the **scope root** (the repository's main worktree, else the launch directory). Replaces `.atlas/shared-memory/events.jsonl` + `state.json` as the Shared tab's store. |
| `.record-store-migrated` | `record::legacy` | Marker: this directory's legacy `shared-memory/events.jsonl` and `extracted/*.md` were folded into its scope's record store. Written in every worktree that had legacy files; the same fact is kept in the store's `legacy_imports` table. The legacy files are kept one release. |

No longer written or read (#89), safe to delete: `graph/` (the grafeo graph;
its content — the legacy shared log — lives in the record store),
`.shared-memory-imported` (its marker), and `.consolidation_lock` /
`.consolidation_state.json` (the dream gates' lock and state; the memdir they
pruned is no longer written, and the record store caps what it shows per kind).

### Global (cross-project) — `~/.atlas/memory/`

| Path | Purpose |
|---|---|
| `MEMORY.md` | Human-readable promoted list, newest first, kept **< 200 lines** (oldest bullets trimmed). |
| `global-promoted.jsonl` | Every promoted memory (`{"content": …}` per line, promotion order, never trimmed) — what global recall searches, together with `MEMORY.md` for promotions older than this file. |
| `global-candidates.json` | Promotion ledger — tracks which content hashes have been seen, in which repositories, and whether they've been promoted. |

Promotion (#89) runs over each repository's record store: a Fact at confidence
≥ 0.8 whose content hash is recorded from ≥ 2 repositories is promoted once.
`global-graph/`, written by older versions, is no longer read. Every promotion
it held was also written to `MEMORY.md`, so recall still finds those older
promotions — except any the list's 200-line cap had already trimmed. Ledger
rows written before #89 (`preference` / `constraint`, keyed by an older hash)
are kept as they are.

The global dir resolves to `~/.atlas/memory/` by default, or the
`ATLAS_GLOBAL_MEMORY_DIR` override (see §3).

### Agent Memory Repo mirror — `~/.atlas/memory-repos/<repo>-<8 hex>/` (M4)

Written only with the setting `memoryRepoMirror` on: a local git repository
(`MEMORY.md`, `decisions.md`, `architecture.md`, `facts.md`, `failures.md`)
holding active, non-stale memories. Derived: deleting it loses nothing, and a
purge rewrites it with fresh history. No remote, nothing is pushed.

---

## 2. Legacy `index.json` (removed in #90)

The flat `<project>/.atlas/memory-index/index.json` is no longer read or
written. Memory ▸ Graph, its natural-language query and the Policy view take
their vectors from this crate's HNSW engine (`MemoryEngine::cached_vector`,
`add_embedded`, `search_ids`), and the one-shot import that used to lift
`index.json` into HNSW on open is gone with it: a project that still has the
file is simply re-embedded by the indexer's first pass. The file (and any
`index.json.bak`) is left on disk untouched.

The legacy `.atlas/shared-memory/events.jsonl` is folded into the record store
by `record::legacy` (guarded by `.record-store-migrated`), not by the engine.

---

## 3. Feature flags & env overrides

| Env var | Default | Effect |
|---|---|---|
| `ATLAS_GLOBAL_MEMORY_DIR` | unset → `~/.atlas/memory/` | Overrides the global memory dir. Used by tests so they never touch the real home dir. |
| `ATLAS_MINILM_DIR` | unset | Points tests at an installed MiniLM model dir (contains `model.safetensors`). Model-gated tests are `#[ignore = "needs ATLAS_MINILM_DIR"]`; run them with `-- --ignored`. They never download a model. |

---

## 4. What remains for rollback

The pre-HNSW brute-force retrieval (`memory_retrieve::retrieve_brute_force`)
has been deleted; HNSW is the only retrieval path and there is no switch back.
What remains:

- **Archived legacy data** — the original `shared-memory/events.jsonl` (and any
  old `memory-index/index.json[.bak]`) remain on disk, unread.

The micro-benchmark `bench_hnsw_vs_brute_force` (in `atlas-memory`'s
`parity_bench` module, `#[ignore]`d; run with `--ignored --nocapture`) measured
HNSW at roughly **two orders of magnitude** faster per query than a brute-force
cosine on a few-thousand-vector corpus.

---

## 5. MANUAL runtime verification

The offline parity tests (`atlas-memory`'s `parity_bench` module) prove the
retrieval path is agent-agnostic and that `RetrievedDoc` maps cleanly onto
`MemDoc`. They do **not** exercise the live app, real API keys, or the loaded
MiniLM model. That last mile is a **manual** runtime check:

**Prerequisites**
- The MiniLM model installed (so `register_memory_search`'s provider resolves).
- Credentials configured for each agent you test.
- A project with some indexed memory (open it and let the `MemoryIndexer` run, or
  call the `force_reindex` command once).

**Steps — repeat for the native agent and at least one ACP agent**
1. `bun run dev:app` and open the test project, with memory sharing enabled.
2. Confirm the background indexer built the index: `<project>/.atlas/memory/corpus.sqlite`
   and `corpus.<model>.usearch` exist (`hnsw.usearch` and `manifest.json` are
   deleted on open by design).
3. **Any agent** (`memory_search` MCP tool): ask about known project memory
   (e.g. an established convention). Verify the agent calls `memory_search`
   and the returned snippets are on-topic.
4. **Native agent** (pull / `search_memory` tool): ask a question that should
   trigger the tool ("what auth strategy does this project use?"). Verify the
   agent invokes `search_memory` and the returned `## title (source)` snippets
   are on-topic.
5. Confirm **identical grounding** across agents — same project + query should
   surface the same underlying docs (the retrieval is shared), differing only in
   which tool presents them.

If any agent loses grounding, file the discrepancy before removing any legacy
path in §4.
