# atlas-memory — Atlas's RAG / memory engine

Atlas's on-device retrieval-augmented memory. It turns a project's files, chat
history, and distilled knowledge into a searchable index that the AI agents use
to ground their answers — fully local by default (no network for the default
path), behind one retrieval callback so every agent (the native agent and any
installed ACP agent) shares it without special-casing.

> New to the codebase? Read this top-to-bottom. Upgrading an existing install or
> debugging on-disk state? See [`MIGRATION.md`](./MIGRATION.md).

> **This crate no longer depends on the old native-agent SDK.** Session-memory
> extraction/persistence and the embedding-provider trait (`src/session.rs`,
> `src/embedding.rs`) came from the SDK, which was deleted in #54; they are
> Atlas's own code now. `tests/behaviour.rs` pins their behaviour — run it before
> touching either. The ported grafeo graph store, its consolidation pass and the
> dream gates were removed in #89 (retrieval is HNSW-only; global promotion runs
> over the record table).

---

## 1. What it does (in one breath)

On-device **MiniLM** (384-d) embeds your corpus into a persistent **usearch HNSW**
index; a background **indexer** keeps that index fresh *off the chat hot path*; a
**retrieve** (HNSW, plus promoted global memory when local is sparse) answers
`search_memory` queries behind the frozen `MemorySearchFn` seam. The **extractor**
distills finished chats into the shared-memory record store, and a **global**
store promotes Facts seen in two or more repositories.

```
   files / chat / decisions ──▶  MiniLM embed ──▶  usearch HNSW  ──┐
                                                                   ├─▶ retrieve ─▶ MemDoc
                                          ~/.atlas global memory  ──┘        ▲
   (indexing runs in the BACKGROUND, never on the chat turn)                │
                                                          search_memory tool / pushed context
```

---

## 2. Why it's split this way

- **`atlas-memory` is a LOW crate**: no Tauri dependency, and it never depends on
  the agent seam. It owns the engine (embed, index, retrieve, extraction, the
  record store, global). This keeps it unit-testable and reusable.
- **The Tauri app layer** (`src-tauri/src/commands/memory_indexer.rs` +
  `memory_retrieve.rs`) owns orchestration: the per-project engine registry, the
  background indexer task, the file watcher, and the BYOK call for extraction.
- **The seam** is `memory_retrieve::retrieve(app, cwd, query, limit)` in
  `src-tauri`, which takes no agent parameter. Two paths reach it:
  - the native agent's `search_memory` dynamic tool, through the
    `MemorySearch = Fn(cwd, query, limit) -> Vec<MemDoc>` callback that
    `commands/agents.rs` installs with
    `atlas_native_agent::engine::memory::register_search`;
  - the per-send `--- RELEVANT PROJECT MEMORY ---` block, pushed into every
    agent's prompt when memory sharing is enabled for the project.

  Changing the engine never touches the agents.

```
native agent ──search_memory──▶ MemorySearch callback ──┐
any agent ──send (sharing on)──▶ pushed memory block ────┴─▶ memory_retrieve::retrieve
                                                                └─▶ registry.engine_for(cwd)
                                                                      └─▶ MemoryEngine::retrieve   (atlas-memory)
```

---

## 3. How a developer uses it

### 3a. "I just want the agents to recall project memory"
Nothing to do — it's wired. The **native agent** has a `search_memory` tool it
calls on demand; with memory sharing enabled for the project, **every agent**
(ACP agents have no pull tool) also gets the top hits *pushed* into its prompt
on each send. Indexing happens automatically: on project open
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

let mut engine = MemoryEngine::open(project_root.into()); // runs migration + opens HNSW
let hits = engine.retrieve("how do we store sessions?", 6).await; // Vec<RetrievedDoc>
for h in hits { println!("{} — {}", h.title, h.source); }
```
`RetrievedDoc { id, title, source, text }`. The Tauri layer maps it onto
`atlas_native_agent::engine::memory::MemDoc { title, source, text }` for the
tool, dropping `id`.

### 3d. "I want to add a new corpus source" (e.g. index a new kind of doc)
Corpus gathering lives in the **app layer**, not this crate: extend
`src-tauri/src/commands/agent_memory.rs::collect_corpus` to emit your new docs as
`MemoryDoc { id, title, text, source }`. The indexer maps each to
`atlas_memory::CorpusDoc` and embeds it on the next index pass. Nothing else to
change — retrieval picks it up automatically.

### 3e. "I want structured memory"
Structured memory is the shared-memory record store (`src/record.rs`): typed
entries (Decision, Fact, Failure, Architecture, …) with confidence and
provenance, one SQLite database per repository. Its entries join the HNSW corpus
through `collect_corpus`, so retrieval finds them semantically.

---

## 4. The write path (indexing) — decoupled from chat

A single background `MemoryIndexer` task (Tokio) drains a bounded queue. **Every
job carries a `cwd`** so multiple open projects stay isolated.

| Trigger | Job |
|---|---|
| Project opened (first `engine_for`) | one cold `IndexCorpus{cwd}` + one `Compact{cwd}` (global promotion) |
| Watched file changes (`*.md`, `CLAUDE.md`, `AGENTS.md`, `codebase-index/docs.json`), debounced ~2s | `IndexCorpus{cwd}` |
| A chat turn finishes | `IndexCorpus{cwd}` (always) + `ExtractSession{cwd,writer,turns}` (the extractor's gated pass) |
| A session ends | `SessionEnded{cwd,writer}` (the extractor's one end-of-session pass) |
| An extractor pass stored entries | `IndexCorpus{cwd}` + `Compact{cwd}` |
| `force_reindex(cwd)` | `IndexCorpus{cwd}` |

The worker: gather corpus → `Manifest::diff` (content-hash) → embed only new/changed
via MiniLM → `HnswStore` add/remove → persist atomically. **No embedding or disk
I/O ever runs synchronously on a prompt.** This is the core fix vs. the old design,
where the vector index was never refreshed mid-session.

---

## 5. The extractor

A finished turn and a session's end are distilled into durable shared memory.
Turn-finished gates (must all hold): **≥20 messages, ≥3 tool calls since the last
pass (after the first), no pending tool_use**. At session end one more pass runs
over whatever arrived since the last one, so a short session still contributes.

- Works for **every agent** via the `AgentHost` snapshot (one normalized
  transcript shape — no per-agent parsing); Atlas's injected blocks are stripped.
- `extract.rs` owns the gates, the prompt (Decision / Fact / Failure /
  Architecture, each with a 0–1 confidence) and the parser; **the model call is
  made by the app layer** (`src-tauri/src/commands/memory_extract.rs`): the Atlas
  gateway by default when signed in, the BYOK provider when the summariser
  preference says `provider`, nothing when it says `local` (reserved).
- Output → the record store (`memory.sqlite`) with source `extractor` and the
  model's confidence, through redaction and dedup; the Shared tab shows it and
  the retrieval index is refreshed.
- `extracted/*.md` is no longer written (existing files were migrated into the
  record store and are kept one release).

---

## 6. On-disk layout

Per project, under `<project>/.atlas/memory/`:

| File | What |
|---|---|
| `hnsw.usearch` | the persistent usearch HNSW index (vectors) |
| `manifest.json` | `{provider_name, dim, next_key, entries:[{id,key,content_hash,corpus,mtime}]}` — id↔u64 key map + incremental ledger |
| `docstore.json` | `id -> {title, source, text}` for building results (vectors alone have no text) |
| `memory.sqlite` | the shared-memory record store (see `src/record.rs`) |
| `extracted/*.md` | legacy session-extraction output (memdir; migrated, no longer written) |

Left behind by older versions and no longer read (safe to delete): `graph/`
(the grafeo store), `.shared-memory-imported`, `.consolidation_state.json`,
`.consolidation_lock`.

Global, under `~/.atlas/memory/` (`~/.atlas-dev/memory/` for the dev profile, see
`atlas-profile`; override `ATLAS_GLOBAL_MEMORY_DIR`):

| File | What |
|---|---|
| `MEMORY.md` | human-readable promoted list (kept < 200 lines, newest first) |
| `global-promoted.jsonl` | every promoted memory, never trimmed — what global recall searches (with `MEMORY.md` for older promotions) |
| `global-candidates.json` | promotion ledger: `content_hash -> {category, max_confidence, project_roots, promoted}` |

`global-graph/`, written by older versions, is no longer read.

**Promotion rule:** a record-store Fact with confidence ≥ 0.8 whose content hash
is seen (at that confidence) in ≥ 2 repositories is promoted to global, once.
Each repository records its own Facts in the ledger when it opens (and after an
extractor pass stores entries); the ledger is what remembers the other
repositories. Everything else stays repository-local.

---

## 7. Configuration (environment flags)

| Flag | Default | Effect |
|---|---|---|
| `ATLAS_MINILM_DIR` | unset | Override the MiniLM model directory (otherwise Atlas's standard app-data model path). Used by tests + custom setups. |
| `ATLAS_GLOBAL_MEMORY_DIR` | `~/.atlas/memory` | Override the global memory dir (tests inject a temp dir so they never touch the real one). |
| `ENABLE_HYDE_EXPANSION` | off | Enables HyDE/lexical query expansion (the full "Hybrid" mode — higher recall on multi-session questions but much slower; off by default). |

---

## 8. Retrieval internals (for tuning)

`MemoryEngine::retrieve(query, limit)`:
1. Embed the query (MiniLM) → `HnswStore::search` → cosine hits; **apply the 0.30
   similarity floor here, on the raw cosine** (not on the fused score).
2. **Jaccard dedup** (≥0.8) → top `limit`.
3. If local hits are sparse (< 3), blend global hits (promoted memories whose
   text contains the query) by **RRF** (`Σ w/(60+rank+1)`, weights `EMBED=1.0`,
   `GLOBAL=0.05`) → Jaccard dedup → top `limit` → `RetrievedDoc`.

The weights guarantee a global hit can never outrank a strong embedding hit.
Tune the consts in `retrieve.rs` / `global.rs`.

---

## 9. Module map

| Module (`src/`) | Responsibility |
|---|---|
| `lib.rs` | `MemoryEngine` (open/retrieve/index_corpus/persist, plus `cached_vector`/`add_embedded`/`search_ids` for Memory ▸ Graph and Policy), `RetrievedDoc`, `CorpusDoc` |
| `provider.rs` | `MiniLmProvider` impl `embedding::EmbeddingProvider` (on-device, `spawn_blocking`) |
| `store.rs` | `HnswStore` over `usearch` (save/load/add/get/remove/search) |
| `manifest.rs` | `Manifest` — id↔key bimap, content-hash `diff` |
| `docstore.rs` | `id -> {title,source,text}` side store |
| `retrieve.rs` | HNSW retrieve + floor + dedup + global blend |
| `extract.rs` | the extractor: gates, four-kind prompt with confidence, parser (model call injected; entries land in the record store via `src-tauri/src/commands/memory_extract.rs`) |
| `record.rs` | the shared-memory record store (+ `record/legacy.rs`, the one-time import of the legacy event log and memdir) |
| `global.rs` | Fact promotion over the record table + global recall |

App layer: `src-tauri/src/commands/memory_indexer.rs` (registry + indexer + watcher
+ `force_reindex`), `memory_retrieve.rs` (the seam wiring).

---

## 10. Testing & validation

- **Unit tests** (offline, no network/model): `cargo test -p atlas-memory`
  (store roundtrip, manifest diff, migration, retrieve fusion/floor/dedup, extraction
  gates, global promotion, the fixture-corpus retrieval goldens), plus
  `tests/behaviour.rs`.
- **Model-dependent tests** are `#[ignore = "needs ATLAS_MINILM_DIR"]`. Run them
  with `ATLAS_MINILM_DIR=<model dir> cargo test -p atlas-memory -- --ignored`;
  they fail, rather than skip, when the variable is unset.
- **The HNSW-vs-brute-force benchmark** (`bench_hnsw_vs_brute_force`) is also
  ignored: `cargo test -p atlas-memory --release bench_hnsw -- --ignored --nocapture`.
- **Live 3-agent validation** (needs the running app, a signed-in account or a
  BYOK summariser, and the MiniLM model): launch `bun run dev:app`, drive a
  tool-heavy session (to clear the extraction gates) or end a short one, then
  confirm extractor entries appear on Memory ▸ Shared and a fresh session recalls
  the planted facts. Full steps in [`MIGRATION.md`](./MIGRATION.md).

---

## 11. Rollback / current status

The new engine is the live retrieval path. The legacy per-turn distill
(`memory_compile`) and its A/B flag are gone: the extractor (gateway by default
when signed in, BYOK when the summariser preference says `provider`) is the only
LLM writer. The old brute-force retrieval (`retrieve_brute_force`) has been
deleted too, so there is no retrieval rollback switch: HNSW is the only path.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No extractor entries after a session | Sharing is off for the project, the summariser is `local` (reserved: nothing runs), not signed in with no BYOK provider chosen, or the gates weren't met on turn finish (≥20 msgs, then ≥3 tool calls) and the session has not ended yet. |
| `search_memory` returns nothing | MiniLM model not present (set `ATLAS_MINILM_DIR` or open the Memory feature to download it), or the index hasn't caught up yet (indexing is debounced/background — wait a couple seconds). |
| Index seems stale | Trigger `force_reindex(cwd)`, or check the dev-terminal `tracing` logs for `IndexCorpus` jobs. |
| Want to start a project's memory fresh | Delete `<project>/.atlas/memory/` (and `.atlas/shared-memory/`); it rebuilds on next open. |
