# `atlas-memory` — Migration & Operations

How Atlas's RAG/memory moved from the in-Tauri **brute-force O(n) cosine** over a
flat `memory-index/index.json` to the on-device **MiniLM → usearch HNSW + grafeo
graph** engine in this crate. Covers the on-disk layout, the legacy migration,
the feature flags, the retained rollback fallbacks, and the **manual** 3-agent
runtime verification.

Background: the originating plan (`plans/atlas-cersei-rag-replan.md`) and the
frozen-seam spec (`crates/atlas-cersei/ARCHITECTURE.md` §6e) were deleted with
the Cersei path (#54); the frozen seam is restated just below, and the native
consumer is now `atlas-native-agent`'s `search_memory` dynamic tool.

> **Frozen seam — unchanged.** `MemDoc { title, source, text }` +
> `MemorySearchFn(cwd, query, limit) -> Vec<MemDoc>` are untouched. All three
> agents (Claude Code / Codex / Cersei) retrieve through the **one** closure
> registered by `register_memory_search` — it takes **no agent-type parameter**,
> so the path is agent-agnostic by construction. `atlas-memory` has **no Tauri**
> dependency and **never** depends on `atlas-cersei`.

---

## 1. On-disk layout

### Per-project — `<project>/.atlas/memory/`

| Path | Written by | Purpose |
|---|---|---|
| `hnsw.usearch` | `HnswStore::save` | Persistent usearch HNSW index (384-d MiniLM vectors, cosine). |
| `manifest.json` | `Manifest::save` | `{ provider_name, dim, next_key, entries[] }`. Holds the `id ↔ u64 key` bimap and per-doc `content_hash` so an unchanged doc is never re-embedded. **Supersedes** the legacy `index.json`. Atomic write (temp + rename). |
| `docstore.json` | `DocStore::save` | `id → { title, source, text }` side-map so retrieval renders docs without re-gathering the corpus. |
| `graph/` | `GraphMemory::open` (Grafeo LPG) | Per-project graph memory: structured facts, topic tags, `link_memories` edges. Falls back to in-memory if the dir can't open (non-fatal — empty until extraction runs). |
| `extracted/*.md` | `extract.rs` | One markdown file per session of gated native session-extraction output (memdir). Also embedded into HNSW. |
| `.shared-memory-imported` | `shared_import.rs` | Idempotency marker: the one-time fold of legacy `.atlas/shared-memory/events.jsonl` into the graph is done. |
| `.consolidation_lock`, `.consolidation_state.json` | `dream::AutoDream` | AutoDream consolidation lock (stale after 3600s) + state (gate timestamps/session counts). |

### Global (cross-project) — `~/.atlas/memory/`

| Path | Purpose |
|---|---|
| `global-graph/` | Global Grafeo graph that outlives any single project. |
| `MEMORY.md` | Human-readable global memory digest. Kept **< 200 lines** (oldest bullets trimmed); the AutoDream "Prune" target. |
| `global-candidates.json` | Promotion ledger — tracks which memories have been seen, in which projects, and whether they've been promoted. |

The global dir resolves to `~/.atlas/memory/` by default, or the
`ATLAS_GLOBAL_MEMORY_DIR` override (see §3).

---

## 2. Legacy `index.json` → HNSW migration

On the **first** `MemoryEngine::open` of a project that has a legacy
`<project>/.atlas/memory-index/index.json` (a flat `{ model, dim, docs:[{id,hash,vector}] }`):

1. If `model == all-MiniLM-L6-v2 && dim == 384` (the same on-device model),
   the stored vectors are imported **directly into HNSW with zero re-embedding** —
   `u64` keys are assigned via the manifest bimap and `manifest.json` is written.
2. The original file is **archived to `index.json.bak`** (archive, never `rm`).
3. A model/dim mismatch leaves the legacy file in place and schedules a full
   rebuild instead (it cannot mix 384-d and other-dim vectors).

Migration is **idempotent**: once archived, every later open is a no-op, and the
first background `IndexCorpus` pass diffs against the migrated manifest so only
genuinely new docs are embedded.

The same `open` then runs a one-time **shared-memory import**: legacy
`.atlas/shared-memory/events.jsonl` (decisions/constraints/facts) is folded into
the graph, guarded by the `.shared-memory-imported` marker; the original log is
kept readable for one release for rollback.

---

## 3. Feature flags & env overrides

| Env var | Default | Effect |
|---|---|---|
| `ATLAS_NATIVE_EXTRACTION` | **OFF** | A/B gate for native session extraction (see below). |
| `ATLAS_GLOBAL_MEMORY_DIR` | unset → `~/.atlas/memory/` | Overrides the global memory dir. Used by tests so they never touch the real home dir. |
| `ATLAS_MINILM_DIR` | unset | Points tests at an installed MiniLM model dir (contains `model.safetensors`). Model-gated tests **skip cleanly** when unset — no network download. |

### `ATLAS_NATIVE_EXTRACTION` (default OFF) — the A/B plan

Accepted truthy values: `1` / `true` / `on` / `yes` (case-insensitive).

- **OFF (default).** On `TurnFinished`, Atlas runs the legacy
  `memory_compile::compile_finished_turn` per-turn BYOK distill (itself a no-op
  unless the project's summarizer is a BYOK provider). This is the validated
  write-side path.
- **ON.** `TurnFinished` instead enqueues `Job::ExtractSession{cwd, agent, session}`
  into the background `MemoryIndexer` for **all three** agents. The gates
  (`should_extract`: ≥20 msgs / ≥3 tool calls / no pending tool_use) decide whether
  to run; on pass, ONE BYOK call (off the hot path) distills the format-neutral
  transcript into `extracted/*.md` + graph nodes, then re-embeds into HNSW.

**A/B plan:** run with the flag ON on a few real sessions per agent, compare the
extracted memories against the `memory_compile` output, and only once the native
path is confirmed at least as good flip it on permanently.

**Deferred `memory_compile` removal:** `memory_compile`'s BYOK round-trip is
**intentionally retained** until the A/B validates the native path. Its removal is
the deferred Step-8 cleanup, gated on that validation — do not delete it as part of
this migration.

---

## 4. Retained rollback fallbacks (do NOT delete)

These legacy paths are kept on purpose as safety nets pending live runtime
validation:

- **`memory_retrieve::retrieve_brute_force` / `retrieve_inner`** (in
  `src-tauri/src/commands/memory_retrieve.rs`, `#[allow(dead_code)]`) — the
  pre-HNSW O(n) cosine path over `atlas_embed::BruteForce`. To roll back, point
  `memory_retrieve::retrieve` at `retrieve_brute_force` instead of the engine path.
- **`memory_compile`** — the legacy write-side distill, still live whenever
  `ATLAS_NATIVE_EXTRACTION` is OFF (the default).
- **Archived legacy data** — `index.json.bak` and the original
  `shared-memory/events.jsonl` remain on disk; restore by un-archiving.

A Step-10 micro-benchmark (`atlas-memory`'s `bench_hnsw_vs_brute_force`) measured
HNSW at roughly **two orders of magnitude** faster per query than the brute-force
cosine on a few-thousand-vector corpus, which is why HNSW is the live path while
brute-force stays only as a rollback.

---

## 5. MANUAL 3-agent runtime verification

The offline parity tests (`atlas-memory`'s `parity_bench` module) prove the
retrieval path is agent-agnostic and that `RetrievedDoc` maps cleanly onto
`MemDoc`. They do **not** exercise the live app, real API keys, or the loaded
MiniLM model. That last mile is a **manual** runtime check:

**Prerequisites**
- The MiniLM model installed (so `register_memory_search`'s provider resolves).
- BYOK / API keys configured for each agent you test (`byok-keys.json`).
- A project with some indexed memory (open it and let the `MemoryIndexer` run, or
  call the `force_reindex` command once).

**Steps — repeat for Claude Code, Codex, and Cersei**
1. `npm run dev:app` and open the test project.
2. Confirm the background indexer built the index: `<project>/.atlas/memory/hnsw.usearch`
   and `manifest.json` exist and `manifest.json`'s `entries[]` is non-empty.
3. **Claude Code** and **Codex** (push / site C): start a chat turn whose message
   references known project memory (e.g. an established convention). Verify the
   forwarded prompt contains a `--- RELEVANT PROJECT MEMORY ---` block with
   on-topic snippets.
4. **Cersei** (pull / `search_memory` tool): ask a question that should trigger the
   tool ("what auth strategy does this project use?"). Verify the agent invokes
   `search_memory` and the returned `## title (source)` snippets are on-topic.
5. Confirm **identical grounding quality** across all three — same project + query
   should surface the same underlying docs (the seam is shared), differing only in
   push-vs-pull presentation.
6. Flip `ATLAS_NATIVE_EXTRACTION=1`, run a long enough session per agent to pass the
   gates (≥20 msgs / ≥3 tool calls), and confirm `extracted/*.md` appears and the
   new memories become retrievable **without a manual rebuild** (the old
   "invisible until rebuild" bug is gone).

If any agent loses grounding, roll back per §4 and file the discrepancy before
removing any legacy path.
