# atlas-memory — Atlas's RAG / memory engine

Atlas's on-device retrieval-augmented memory. It turns a project's files, chat
history, and distilled knowledge into a searchable index that the AI agents use
to ground their answers — fully local by default (no network for the default
path), behind one stable seam so all three agents (Claude Code, Codex, Atlas)
share it without special-casing.

> New to the codebase? Read this top-to-bottom. Upgrading an existing install or
> debugging on-disk state? See [`MIGRATION.md`](./MIGRATION.md). Want the design
> **2026-08-22 — this crate no longer depends on the Cersei SDK.** The graph
> store, the memory-type taxonomy, session-memory extraction/persistence, the
> consolidation gates, and the embedding-provider trait were ported in as
> `src/graph.rs`, `src/session.rs`, `src/dream.rs` and `src/embedding.rs`.
> `tests/cersei_parity.rs` was written against the SDK versions and passes
> unchanged against the ported ones — run it before touching any of those four.
> It also pins several inherited quirks on purpose (quote-wrapped query results,
> duplicate `:Topic` nodes, an inert `recall_top_k` ranking); fixing one means
> editing that file in the same commit.

> rationale + the build plan? The originating plan and the frozen-seam spec
> lived in `plans/atlas-cersei-rag-replan.md` and
> `crates/atlas-cersei/ARCHITECTURE.md` §6e — both deleted with the Cersei
> path (#54). The seam itself is stated below and enforced by this crate's
> tests; the native consumer is now `atlas-native-agent`'s `search_memory`
> dynamic tool.

---

## 1. What it does (in one breath)

On-device **MiniLM** (384-d) embeds your corpus into a persistent **usearch HNSW**
index; a background **indexer** keeps that index fresh *off the chat hot path*; a
fused **retrieve** (HNSW + graph memory) answers `search_memory` queries behind the
frozen `MemorySearchFn` seam. Optional **session extraction** distills finished
chats into durable memories, and a **global** store promotes cross-project facts.

```
   files / chat / decisions ──▶  MiniLM embed ──▶  usearch HNSW  ──┐
                                       +  grafeo graph memory      ├─▶ fused retrieve ─▶ MemDoc
                                       +  ~/.atlas global memory  ──┘        ▲
   (indexing runs in the BACKGROUND, never on the chat turn)                │
                                                          search_memory tool / pushed context
```

---

## 2. Why it's split this way

- **`atlas-memory` is a LOW crate**: no Tauri dependency, and it never depends on
  `atlas-cersei`. It owns the engine (embed, index, retrieve, graph, extraction,
  global). This keeps it unit-testable and reusable.
- **The Tauri app layer** (`src-tauri/src/commands/memory_indexer.rs` +
  `memory_retrieve.rs`) owns orchestration: the per-project engine registry, the
  background indexer task, the file watcher, and the BYOK call for extraction.
- **The seam** (`atlas-cersei/src/memory.rs`): a single injected callback
  `MemorySearchFn(cwd, query, limit) -> Vec<MemDoc>`. **This shape is frozen** —
  all three agents retrieve through it, so changing the engine never touches the
  agents.

```
agent ──search_memory──▶ MemorySearchFn closure ──▶ memory_retrieve::retrieve
                                                        └─▶ registry.engine_for(cwd)
                                                              └─▶ MemoryEngine::retrieve   (atlas-memory)
```

---

## 3. How a developer uses it

### 3a. "I just want the agents to recall project memory"
Nothing to do — it's wired. The **Atlas/Cersei** agent has a `search_memory` tool
it calls on demand; **Claude Code / Codex** get the top hits *pushed* into their
prompt (they have no pull tool). Indexing happens automatically: on project open
(cold index), on file changes (watched + debounced), and after each finished turn.

### 3b. "I want to force a reindex"
Invoke the Tauri command:
```ts
await invoke("force_reindex", { cwd: projectPath })
```
This enqueues a background `IndexCorpus` job for that project.

### 3c. "I want to query the engine directly (Rust)"
```rust
use atlas_memory::MemoryEngine;

let mut engine = MemoryEngine::open(project_root.into()); // runs migration + opens HNSW/graph
let hits = engine.retrieve("how do we store sessions?", 6).await; // Vec<RetrievedDoc>
for h in hits { println!("{} — {}", h.title, h.source); }
```
`RetrievedDoc { id, title, source, text }`. The Tauri layer maps it onto
`atlas_cersei::MemDoc { title, source, text }` at the seam.

### 3d. "I want to add a new corpus source" (e.g. index a new kind of doc)
Corpus gathering lives in the **app layer**, not this crate: extend
`src-tauri/src/commands/agent_memory.rs::collect_corpus` to emit your new docs as
`MemoryDoc { id, title, text, source }`. The indexer maps each to
`atlas_memory::CorpusDoc` and embeds it on the next index pass. Nothing else to
change — retrieval picks it up automatically.

### 3e. "I want richer/structured memory" (graph)
`MemoryEngine` holds a `GraphMemory` (grafeo, `src/graph.rs` — Atlas-owned since 2026-08-22). Extraction (§5) writes
typed memories into it. Graph hits are a **down-weighted** contributor to
retrieval (it's substring/word-overlap, not semantic) — the embedding path is
always authoritative.

---

## 4. The write path (indexing) — decoupled from chat

A single background `MemoryIndexer` task (Tokio) drains a bounded queue. **Every
job carries a `cwd`** so multiple open projects stay isolated.

| Trigger | Job |
|---|---|
| Project opened (first `engine_for`) | one cold `IndexCorpus{cwd}` + one `Compact{cwd}` |
| Watched file changes (`*.md`, `CLAUDE.md`, `AGENTS.md`, `codebase-index/docs.json`), debounced ~2s | `IndexCorpus{cwd}` |
| A chat turn finishes | `IndexCorpus{cwd}` (always) + `ExtractSession{cwd,agent,session}` (only if extraction flag on) |
| `force_reindex(cwd)` | `IndexCorpus{cwd}` |

The worker: gather corpus → `Manifest::diff` (content-hash) → embed only new/changed
via MiniLM → `HnswStore` add/remove → persist atomically. **No embedding or disk
I/O ever runs synchronously on a prompt.** This is the core fix vs. the old design,
where the vector index was never refreshed mid-session.

---

## 5. Session extraction (optional, flag-gated)

When enabled, a finished turn is distilled into durable memories instead of the
legacy per-turn distiller. Gates (must all hold): **≥20 messages, ≥3 tool calls
since last extraction, no pending tool_use** — so short chats extract nothing.

- Works for **all three agents** via `AgentManager::snapshot` (one normalized
  transcript shape — no per-agent parsing).
- The SDK supplies the gates + prompt + parser; **the BYOK LLM call is made by the
  app layer** (injected, so `atlas-memory` stays provider-free).
- Output → `extracted/*.md` (Claude-compatible memdir) + the graph, then embedded
  into HNSW on the same indexer pass.
- Categories `UserPreference / ProjectFact / CodePattern / Decision / Constraint`
  map (lossily) to the graph's `MemoryType`, with the precise category kept as a
  **topic tag**.

**Default OFF.** See §7 for the flag and the A/B plan.

---

## 6. On-disk layout

Per project, under `<project>/.atlas/memory/`:

| File | What |
|---|---|
| `hnsw.usearch` | the persistent usearch HNSW index (vectors) |
| `manifest.json` | `{provider_name, dim, next_key, entries:[{id,key,content_hash,corpus,mtime}]}` — id↔u64 key map + incremental ledger |
| `docstore.json` | `id -> {title, source, text}` for building results (vectors alone have no text) |
| `graph/` | `graph::GraphMemory` (grafeo) store |
| `extracted/*.md` | session-extraction output (memdir) |
| `.shared-memory-imported` | idempotency marker for the legacy `shared-memory/events.jsonl` import |
| `.consolidation_state.json` / `.consolidation_lock` | AutoDream consolidation state + lock |

Global, under `~/.atlas/memory/` (override `ATLAS_GLOBAL_MEMORY_DIR`):

| File | What |
|---|---|
| `global-graph/` | cross-project promoted memories |
| `MEMORY.md` | human-readable promoted list (kept < 200 lines) |
| `global-candidates.json` | promotion ledger: `content_hash -> {category, max_confidence, project_roots, promoted}` |

**Promotion rule:** a `UserPreference`/`Constraint` with confidence ≥ 0.8 seen in
≥ 2 distinct projects is promoted to global. Everything else stays project-local.

---

## 7. Configuration (environment flags)

| Flag | Default | Effect |
|---|---|---|
| `ATLAS_NATIVE_EXTRACTION` | **off** | `1/true/on/yes` → finished turns use the new gated extraction (`extracted/*.md`) and skip the legacy `memory_compile` distiller. The A/B switch — flip on to validate, then it becomes the default and `memory_compile` is removed. |
| `ATLAS_MINILM_DIR` | unset | Override the MiniLM model directory (otherwise Atlas's standard app-data model path). Used by tests + custom setups. |
| `ATLAS_GLOBAL_MEMORY_DIR` | `~/.atlas/memory` | Override the global memory dir (tests inject a temp dir so they never touch the real one). |
| `ENABLE_HYDE_EXPANSION` | off | Enables HyDE/lexical query expansion (the full "Hybrid" mode — higher recall on multi-session questions but much slower; off by default). |

---

## 8. Retrieval internals (for tuning)

`MemoryEngine::retrieve(query, limit)`:
1. Embed the query (MiniLM) → `HnswStore::search` → cosine hits; **apply the 0.30
   similarity floor here, on the raw cosine** (not on the fused score).
2. `GraphMemory::recall_top_k` → graph hits, **down-weighted**.
3. If local hits are sparse (< 3), blend `~/.atlas` global hits at a tiny weight.
4. **RRF fuse** (`Σ w/(60+rank+1)`, weights `EMBED=1.0`, `GRAPH=0.1`, `GLOBAL=0.05`)
   → **Jaccard dedup** (≥0.8) → top `limit` → `RetrievedDoc`.

The weights guarantee a graph/global hit can never outrank a strong embedding hit.
Tune the consts in `retrieve.rs` / `global.rs`.

---

## 9. Module map

| Module (`src/`) | Responsibility |
|---|---|
| `lib.rs` | `MemoryEngine` (open/retrieve/index_corpus/persist), `RetrievedDoc`, `CorpusDoc` |
| `provider.rs` | `MiniLmProvider` impl `embedding::EmbeddingProvider` (on-device, `spawn_blocking`) |
| `store.rs` | `HnswStore` over `usearch` (save/load/add/remove/search) |
| `manifest.rs` | `Manifest` — id↔key bimap, content-hash `diff` |
| `docstore.rs` | `id -> {title,source,text}` side store |
| `migrate.rs` | legacy `memory-index/index.json` → HNSW (no re-embed) |
| `shared_import.rs` | legacy `shared-memory/events.jsonl` → graph (idempotent) |
| `retrieve.rs` | fused RRF retrieve + floor + dedup |
| `extract.rs` | gated session extraction (injected BYOK call) |
| `consolidate.rs` | AutoDream-gated prune of the memdir |
| `global.rs` | cross-project promotion + global store |

App layer: `src-tauri/src/commands/memory_indexer.rs` (registry + indexer + watcher
+ `force_reindex`), `memory_retrieve.rs` (the seam wiring).

---

## 10. Testing & validation

- **Unit tests** (offline, no network/model): `cd crates/atlas-memory && cargo test`
  (store roundtrip, manifest diff, migration, retrieve fusion/floor/dedup, extraction
  gates, consolidation, global promotion). Model-dependent tests skip cleanly unless
  `ATLAS_MINILM_DIR` is set.
- **Live 3-agent validation** (needs the running app + a BYOK key + the MiniLM model):
  launch `ATLAS_NATIVE_EXTRACTION=1 bun run dev:app`, drive a tool-heavy session
  (to clear the extraction gates), then confirm `extracted/*.md` appears and a fresh
  session recalls the planted facts. Full steps in [`MIGRATION.md`](./MIGRATION.md).

---

## 11. Rollback / current status

The new engine is the live retrieval path, but two safety nets remain until the
flag is validated and made default:
- **`ATLAS_NATIVE_EXTRACTION` default OFF** → the legacy `memory_compile` distiller
  is still the default capture path.
- **`retrieve_brute_force`** (the old O(n) cosine path) is retained
  (`#[allow(dead_code)]`) for rollback.

Once live validation passes: flip the flag default-on, delete `retrieve_brute_force`
and the `memory_compile` distiller (the deferred parts of Steps 8/10 in the plan).

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No `extracted/*.md` after a session | `ATLAS_NATIVE_EXTRACTION` not active (app was already running — relaunch with the flag), or the gates weren't met (need ≥20 msgs + ≥3 tool calls), or no BYOK key for the extraction call. |
| `search_memory` returns nothing | MiniLM model not present (set `ATLAS_MINILM_DIR` or open the Memory feature to download it), or the index hasn't caught up yet (indexing is debounced/background — wait a couple seconds). |
| Index seems stale | Trigger `force_reindex(cwd)`, or check the dev-terminal `tracing` logs for `IndexCorpus` jobs. |
| Want to start a project's memory fresh | Delete `<project>/.atlas/memory/` (and `.atlas/shared-memory/`); it rebuilds on next open. |
