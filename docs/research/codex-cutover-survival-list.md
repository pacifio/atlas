# Codex cutover survival list: what must not break, and whether the reliability claim holds

**Sources read at:**
- `~/Codes/atlas` @ `81764f17a238ecc8f278559e2d82c17ef4bb6aff`. Citations like `crates/...`, `src-tauri/...`, `src/...` are relative to this root.
- `~/Codes/codex` @ `42b5f05cef69491bc578901fb324b3c9a278b253` — the exact fork point named in ADR-0003. Citations like `codex-rs/...` are relative to this root.
- One citation is to third-party crate source: `eventsource-stream-0.2.3` (the exact version in `codex-rs/Cargo.lock:6174-6176`), read from the local cargo registry cache.

**Companion docs (facts assumed, not re-derived):** [codex-fork-seam.md](codex-fork-seam.md) (crate spine, BYOK distance, `requires_openai_auth:false` + `env_key`/`experimental_bearer_token`), [codex-atlas-integration-surface.md](codex-atlas-integration-surface.md) (`InProcessAppServerClient` recommendation, seam classification in its §3).

**Deletion under study (ADR-0003):** `crates/atlas-cersei`, the crates.io `cersei*` SDK crates, `vendor/cersei-provider`, `vendor/cersei-agent`, and the `[patch.crates-io]` entries (src-tauri/Cargo.toml:223, 228). `crates/atlas-native-agent` is the seam and is **not** deleted; its impl bodies are rewritten (docs/adr/0003-codex-fork-as-native-agent.md:17).

---

## TL;DR

1. **A1 History: SURVIVES.** The thread-metadata store has zero Cersei dependencies (crates/atlas-thread-metadata/Cargo.toml has no `cersei` entry; deps are atlas-acp-thread + acp 2.0, lines 17-18) and identifies the agent by a plain string column (`agent_id TEXT NOT NULL`, crates/atlas-thread-metadata/src/schema.rs:85). Existing rows keep rendering after the deletion.
2. **One history caveat:** the *rows* survive; *replay* of pre-cutover native conversations does not. Opening an old native row goes through `CerseiConnection::load_session` → `runtime.replay_session`, which reads Cersei's own JSON files under `<config_dir>/cersei-sessions/` (crates/atlas-native-agent/src/connection.rs:250-279; crates/atlas-cersei/src/store.rs:3-5). The codex engine cannot read that format; without a migration those rows open empty or error.
3. **The new agent's history obligations are two:** keep answering to agent id `"cersei"` (or migrate the column), and render events onto `AcpThread` like every agent — recording is then automatic via `HistoryObserver` (src-tauri/src/commands/agent_host.rs:1673-1708).
4. **A2 Settings/credentials: SURVIVE — and the part that dies is already dead weight.** Atlas's real key store is the user's shell environment, owned by `src-tauri/src/commands/byok.rs` (env-entry-only, byok.rs:1-16). The Cersei runtime instead reads a legacy `byok-keys.json` (crates/atlas-cersei/src/store.rs:25-31) that **nothing in the repo writes anymore** — the deletion removes a reader of a file with no writer. The codex port wires env-sourced keys via `ModelProviderInfo { env_key / experimental_bearer_token, requires_openai_auth: false }` (codex-rs/model-provider-info/src/lib.rs:100-108, 136-138, 290-296).
5. **A3 Working turn: the compile surface is small and enumerated** (§A3): two types, one const, three named methods, four runtime calls, one callback registration, one patch-guard const. Everything else src-tauri needs flows through the `AgentServer`/`AgentConnection` traits, which survive.
6. **A4 Memory/RAG: atlas-memory is LIVE, and the whole RAG stack survives for free.** `atlas-memory`, `atlas-embed`, `atlas-codeindex` have zero cersei dependencies (their Cargo.tomls contain no `cersei` entries) and are driven directly by src-tauri commands. `atlas-cersei/src/memory.rs` is *not* a memory engine — it is a thin `search_memory` tool that calls a callback injected from src-tauri (crates/atlas-cersei/src/memory.rs:7-10, 36-40). What dies: that tool projection, and Cersei transcripts as a memory-corpus source (`corpus_sessions`).
7. **B verdict: the evidence SUPPORTS the reliability claim.** Codex has a real end-to-end interrupt (token cancel → graceful window → task abort → SIGTERM then SIGKILL of the tool's process group, § B1), a real stream-retry loop (5 stream reconnects / 4 request retries by default, exponential backoff with jitter, `Retry-After` honored, websocket→HTTPS fallback, retry re-prompts from recorded session history so completed work is not lost, § B2), correct incremental UTF-8 SSE decoding — the exact bug class Atlas vendor-patched cannot occur (§ B3) — and a 300 s stream idle timeout (§ B4).
8. **Honest nuance on "Atlas lacks":** the Cersei path *does* retry today — but only because Atlas hand-wrote the retry table into its vendored fork (`ATLAS PATCH (retry-classified-v1)`, vendor/cersei-agent/src/retry.rs:1-16), classifying errors by message-substring matching. That is ADR-0003's vendor-fork treadmill in one file, and it strengthens rather than weakens the case.

---

## Question A — the survival list

### A1. Chat history in the sidebar

**Does the store depend on Cersei?** No. `crates/atlas-thread-metadata`'s dependencies are anyhow, rusqlite, chrono, serde, tokio, tracing, uuid, plus `atlas-acp-thread` and `agent-client-protocol =2.0.0` for the `AgentId`/`acp::SessionId` types the rows are presented in (crates/atlas-thread-metadata/Cargo.toml:17-18). There is no `cersei` or `atlas-cersei` entry anywhere in the manifest. The agent is identified by a literal string column — `agent_id TEXT NOT NULL` (crates/atlas-thread-metadata/src/schema.rs:85) — and the store's own header states the design intent: it stores the id literally and special-casing one agent in the storage layer is forbidden (crates/atlas-thread-metadata/src/store.rs:17).

**Who writes rows during a native chat.** The store is opened at host construction: `ThreadMetadataStore::open(atlas_thread_metadata::db_path(&config_dir))` wrapped in a `ThreadRecorder` (src-tauri/src/commands/agent_host.rs:289-290; `db_path` at crates/atlas-thread-metadata/src/lib.rs:69). Three write triggers:

1. **Session connect** — `history.record_connected(&record.plugin_id.as_str().into(), &session_id, snapshot_of(&thread))` fires the moment a conversation exists, before anything is typed (agent_host.rs:685-691; recorder at crates/atlas-thread-metadata/src/recorder.rs:124-131).
2. **Every metadata-affecting thread event** — `HistoryObserver` (agent_host.rs:1673) implements `ThreadObserver::on_thread_event` and calls `history.record(&plugin_id.as_str().into(), session_id, event, snapshot_of(thread))` (agent_host.rs:1676-1707; recorder.rs:139-152). This is agent-agnostic: it fires for any agent whose events are projected onto an `AcpThread`, native or ACP.
3. **Resume adoption / draft cleanup** — `history.adopt(session_id, thread_id)` when a history row is reopened (agent_host.rs:1294; recorder.rs:114), `history.forget(...)` when an unused draft's session closes (agent_host.rs:748; agents.rs:992; recorder.rs:173).

The key passed in every case is `record.plugin_id` / `plugin_id_for_agent(...)` — for the native agent that is `CERSEI_AGENT_ID`, defined as `atlas_cersei::CERSEI_PLUGIN_ID` = `"cersei"` (crates/atlas-native-agent/src/server.rs:28; crates/atlas-cersei/src/lib.rs:70). The server.rs doc comment states the contract outright: "The same string the old stack used as its plugin id, so a stored session that names `"cersei"` still resolves after the port" (server.rs:26-27).

**Who reads rows for the sidebar.** `AgentHost::thread_projects` is documented as "The sidebar's only source" (agent_host.rs:1360-1363) and `thread_history` is the history view (agent_host.rs:1378); both read only the store. They are exposed as `threads_projects` / `threads_history` Tauri commands (src-tauri/src/commands/agents.rs:1042, 1050) and invoked by the frontend at src/features/chat/lib/history-api.ts:57, 62 (resume/delete at :81, :86 → `threads_resume`/`threads_delete`, agents.rs:1020, 1031 → `resume_thread`/`delete_thread`, agent_host.rs:1256, 1337).

**Conclusion: history survives the deletion.** The store, the recorder, the observer, the commands, and the frontend never touch a Cersei type. What the new Atlas Agent must do to keep the sidebar working:

1. **Keep occupying agent id `"cersei"`** so existing rows' `agent_id` keeps resolving to a launchable agent — or ship a one-time `UPDATE threads SET agent_id = ...` migration. (The constant's new home just stops being `atlas_cersei::CERSEI_PLUGIN_ID`.)
2. **Render events onto `AcpThread`** through the seam's sink (crates/atlas-native-agent/src/sink.rs) — row recording then happens with zero new code, via triggers 1-3 above.
3. **Decide the replay story for old rows.** This is the one real loss: `resume_thread` for a native row calls `CerseiConnection::load_session`, which loads and replays from Cersei's store — `runtime.load_session(...)` + `runtime.replay_session(&cwd_str, &session_id.to_string())` (crates/atlas-native-agent/src/connection.rs:262-274), backed by JSON files at `<config_dir>/cersei-sessions/<cwd-hash>/<session_id>.json` (crates/atlas-cersei/src/store.rs:3-5). Codex replays from its own rollout files (codex-rs/core/src/thread_manager.rs:938) and cannot read Cersei's format. Options are a transcript migration at cutover or accepting that pre-cutover native rows open without replay; the source answers neither — it is a product decision.

### A2. Settings and BYOK credentials

**Where keys actually live: the user's shell environment, owned by Atlas.** `src-tauri/src/commands/byok.rs` opens with the design statement: "**Atlas stores no API keys.** It used to keep them in a private JSON file; that store is gone. A key lives... an `export` in their shell profile — and Settings ▸ API Keys is an editor for those lines, not a vault" (byok.rs:1-6). Reading is process-env plus a one-time `$SHELL -lic` probe (byok.rs:18-28); writing is `byok_env_set`, which rewrites the profile assignment atomically (byok.rs:30-36, 515). In-process consumers get keys via the `byok_get` command reading the in-memory env snapshot (byok.rs:563-566) — used by modelchat, memory summarisation, and the code index (src-tauri/src/commands/modelchat.rs:309, memory_summarize.rs:78, codebase_index.rs:171). ACP agents get keys as spawn env via `sync_agent_key_env` → `host.store().set_byok_env(agent_key_env())` (byok.rs:298-300). **All of this is Atlas-owned and survives untouched.**

**How the key reaches the Cersei provider today — the part that dies.** At `send_prompt` time the runtime resolves `(provider, key)` itself: `store::byok_get(&self.inner.config_dir, &provider_id)` → `provider::build_provider(&provider_id, &api_key, &model)` (crates/atlas-cersei/src/lib.rs:604-612; builder at crates/atlas-cersei/src/provider.rs:42-72, which calls the cersei SDK's `.api_key(...)` builders). `store::byok_get` reads `<config_dir>/byok-keys.json` (crates/atlas-cersei/src/store.rs:25-31), and the model picker is likewise derived from that file (`configured_models` / `default_provider_model` via `store::byok_providers`, lib.rs:868-880, 895-912).

**Finding: `byok-keys.json` has no writer left.** A repo-wide search (src-tauri, crates, and the frontend `src/`) finds the string `byok-keys` only inside `crates/atlas-cersei` (store.rs:6, 25-40 and the lib.rs:153 doc comment). The old JSON store's writer was removed in the env-entry-only migration (byok.rs:2-4 says so in prose). So the Cersei-specific leg of the path — file read → SDK builder — is a reader of a file only pre-migration installs ever had. *Code-level inference, clearly labeled:* on a fresh install the native agent's key lookup fails with "No API key configured for '{provider}'" (lib.rs:606-608) regardless of what Settings ▸ API Keys shows; I did not run the app to confirm the runtime behavior.

**Conclusion: after deletion, nothing of value is lost, and the port's task is defined.** The surviving source of truth is the env-key state in byok.rs. For the Codex-ported agent to accept the same keys, per the fork-seam doc's finding: construct a `ModelProviderInfo` with `requires_openai_auth: false` ("If false (which is the default), login screen is skipped", codex-rs/model-provider-info/src/lib.rs:136-138) and supply the key either by `env_key` (an env-var name resolved at request time, lib.rs:290-296 — Atlas's `ENV_KEY_VARS` table at byok.rs:59+ already names the canonical vars per provider) or by `experimental_bearer_token` (a literal token in provider config, "necessary when using this programmatically", lib.rs:105-108) fed from `byok::byok_get`'s snapshot. The seam's own header already states the target: the native agent "authenticates with BYOK keys from Atlas's settings, not with an ACP auth method" and advertises `auth_methods` = `&[]` (crates/atlas-native-agent/src/lib.rs:28-31; connection.rs:303-310 region). Non-key settings (default mode, effort) ride the seam's existing `ConnectOptions`/sub-trait surface and are unaffected.

### A3. The minimum surface for a working turn

Everything `src-tauri` imports from the two crates, from an exhaustive grep of `src-tauri/src` for `atlas_cersei`/`atlas_native_agent` plus the manifest (src-tauri/Cargo.toml:74 `atlas-native-agent`, :77 `atlas-cersei`, :85 `cersei-provider`):

**From `atlas-native-agent` (the seam — kept, bodies rewritten):**

| Item | Call sites |
|---|---|
| `CerseiAgentServer::new(config_dir)` + `.runtime()`, then held as `Arc<dyn AgentServer>` | agent_host.rs:47 (import), 296-298 |
| `CERSEI_AGENT_ID` for native-vs-ACP routing | agent_host.rs:47; agents.rs:154; capture.rs:2138; catalog.rs:366-401 (tests) |
| `CerseiConnection` — downcast target for the two native-only knobs | `native_connection` at agent_host.rs:1045-1048 |
| `session_effort(...)` on the downcast connection | agent_host.rs:1022-1031 (`set_effort`; command `agents_set_effort`, agents.rs:1418) |
| `session_compression(...)` on the downcast connection | agent_host.rs:1034-1043 (`set_compress`; command `agents_set_compress`, agents.rs:1427) — **no codex counterpart; this control dies** (integration-surface §3.2) |

**From `atlas-cersei` directly (all die; each needs a replacement decision):**

| Item | Call sites | Fate |
|---|---|---|
| `CerseiRuntime` held as `native_runtime` field | agent_host.rs:254 | replaced by the codex engine handle |
| `native_runtime.list_sessions(cwd)` → `SessionMeta` | `native_sessions`, agent_host.rs:375-389; commands `cersei_list_sessions`/`cersei_delete_session` (src-tauri/src/commands/cersei.rs:22-43, registered at src-tauri/src/lib.rs:565-566); also memory_timeline.rs:131 | codex `thread/list` equivalent, or delete the commands (sidebar's real source is the store, A1) |
| `native_runtime.delete_session(cwd, id)` | agent_host.rs:391-397 | same |
| `atlas_cersei::corpus_sessions(config_dir, project_path)` — native transcripts as memory-corpus docs | agent_memory.rs:434-440 | re-source from codex rollouts or drop (A4) |
| `atlas_cersei::register_memory_search` + `MemDoc` — injects RAG retrieval into the `search_memory` tool | agents.rs:672-684 | re-implement as a tool on the codex engine (A4) |
| `cersei_provider::utf8::ATLAS_UTF8_PATCH` compile guard | src-tauri/src/lib.rs:26 (dep at Cargo.toml:85, patch entries at :223, :228) | deleted with the vendor forks |

(mcp.rs:8 and tool_stats.rs:23 mention `atlas_cersei` in doc comments only — no code dependency.)

**Everything else a turn needs is trait-shaped and survives:** connect/new_session/prompt/cancel/set_mode/set_model flow through `Arc<dyn AgentServer>` (crates/atlas-agent-servers) and `Arc<dyn AgentConnection>` (crates/atlas-acp-thread/src/connection.rs), e.g. `prompt` and `cancel` on the native connection at crates/atlas-native-agent/src/connection.rs:312, 331, driven by the agent-agnostic `agents_send`/`agents_cancel` commands (agents.rs:1127, 1377). **The porting target is therefore:** implement `AgentServer` + `AgentConnection` (+ `session_effort`) over the codex engine inside `atlas-native-agent`, keep the `"cersei"` agent id resolving, provide or delete the four direct-runtime calls above, and re-register a memory-search tool. That is the entire list; with it, src-tauri builds and a turn completes.

### A4. Memory/RAG: which one is live?

**`atlas-memory` is live.** src-tauri depends on it directly (src-tauri/Cargo.toml:90) and drives it from commands: `memory_indexer.rs` constructs and feeds `atlas_memory::MemoryEngine`/`MiniLmProvider` and calls `atlas_memory::consolidate` and `extract::extract_and_store` (src-tauri/src/commands/memory_indexer.rs:25, 475, 532-560); `memory_retrieve.rs` performs engine-backed retrieval via `MemoryEngine::retrieve` (memory_retrieve.rs:70-105). `atlas-embed` (Cargo.toml:86, metal feature at :167-169) and `atlas-codeindex` (Cargo.toml:93) are likewise wired (memory_graph.rs:14, codebase_index.rs:18, mention_search.rs:147-164).

**`atlas-cersei/src/memory.rs` is not a competing engine.** It is a ~thin `search_memory` *tool* whose retrieval is injected: "The retrieval itself lives in the Tauri layer... so it's injected via a registered async callback" (crates/atlas-cersei/src/memory.rs:7-10; `register_memory_search` at :36-40). src-tauri registers the callback at startup, and the callback calls `memory_retrieve::retrieve` — i.e. the atlas-memory engine (agents.rs:670-684). So the "two implementations with no dependency between them" premise dissolves on inspection: there is one engine (atlas-memory) and one Cersei-side tool projection over it.

**Independence, verified at the manifests:** `crates/atlas-memory/Cargo.toml`, `crates/atlas-embed/Cargo.toml`, and `crates/atlas-codeindex/Cargo.toml` contain no `cersei` dependency of any kind (atlas-memory's deps are grafeo/usearch/atlas-embed/etc.; atlas-codeindex's are tree-sitter grammars). The `cersei` mentions in atlas-memory's sources are provenance comments — the code was *ported from* the cersei SDK and re-implemented, with an explicit invariant that it must not depend on atlas-cersei (crates/atlas-memory/src/parity_bench.rs:32-34, shared_import.rs:11). The stale comment in atlas-cersei's own manifest claiming "atlas-codeindex/atlas-memory do the same" about cersei features (crates/atlas-cersei/Cargo.toml:16) describes a dependency that no longer exists.

**Plain statement: the RAG stack survives the deletion for free.** What dies with atlas-cersei is exactly two things: (1) the `search_memory` tool projection — the codex-ported agent needs an equivalent tool (codex's tool registry, codex-rs/tools) calling the same injected `memory_retrieve::retrieve`; (2) native-agent transcripts as a corpus *source* — `read_cersei_docs` folds `corpus_sessions` output into the memory index (agent_memory.rs:434-460) and loses its input format; the replacement reads codex rollouts or the feature narrows.

---

## Question B — the reliability evidence

Verified against `~/Codes/codex` source at the fork commit; nothing below is taken from docs or README claims.

### B1. Mid-turn cancel/interrupt

The chain, end to end:

1. `Op::Interrupt` (codex-rs/protocol/src/protocol.rs:544) arrives at the submission loop → `interrupt(&sess)` (codex-rs/core/src/session/handlers.rs:527-529, fn at :60) → `Session::interrupt_task` → `abort_all_tasks(TurnAbortReason::Interrupted)` (codex-rs/core/src/session/mod.rs:4057-4060; codex-rs/core/src/tasks/mod.rs:494).
2. **Per running task** (`handle_task_abort`, tasks/mod.rs:880-940): cancel the task's `CancellationToken` (:887), wait up to `GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100` ms for graceful completion (:66, :905-910), then hard-`abort()` the tokio task handle (:914), then run the task's `SessionTask::abort` cleanup hook (:916-918). An interrupted-turn marker is written to the rollout **and flushed before `TurnAborted` is emitted**, so clients that re-read history on abort see a consistent file (:920-938).
3. **The in-flight HTTP/SSE request** dies with the token: the whole turn pipeline runs every await under `or_cancel(&cancellation_token)` — a `tokio::select!` against `token.cancelled()` that drops the pending future (codex-rs/async-utils/src/lib.rs:25-31; used throughout the turn at codex-rs/core/src/session/turn.rs:195, 327, 924, and the sampling request receives a child token at turn.rs:371). Dropping the stream future drops the reqwest response, closing the connection; there is no "drain to completion in the background".
4. **A running exec child is killed, process-group-wide, TERM-then-KILL.** The exec wait loop selects on an `ExecExpiration` that resolves `Cancelled` when the same token fires (codex-rs/core/src/exec.rs:148-198). On `Cancelled`: `terminate_process_group(pgid)` (SIGTERM to the group), a `CANCELLATION_TERMINATION_GRACE_PERIOD = 50` ms window for TERM-aware cleanup, then `kill_process_group` / `kill_child_process_group` + `child.start_kill()` (SIGKILL) if it has not exited (exec.rs:66, 1026-1057; group-kill helpers at codex-rs/utils/pty/src/process_group.rs:230, 265). Timeouts take the same kill path (exec.rs:1018-1024).
5. The turn surfaces `EventMsg::TurnAborted { reason: Interrupted }` (codex-rs/protocol/src/protocol.rs:1448, 3970), and `Op::RecoverTurn` exists to resume an interrupted regular turn (protocol.rs:575-579).

### B2. Retry on stream failure

Exists, at two cooperating layers.

**Turn-level stream retry** — the sampling loop in `codex-rs/core/src/session/turn.rs:1347-1424`: `max_retries = provider.stream_max_retries()` (:1347), and on error from a sampling attempt, non-retryable errors return immediately (:1409-1411) while retryable ones go through `handle_retryable_response_stream_error` (codex-rs/core/src/responses_retry.rs:44-130) and loop.

- **Policy/constants:** default `stream_max_retries = 5`, `request_max_retries = 4`, both user-configurable and hard-capped at 100 (codex-rs/model-provider-info/src/lib.rs:25-32, 309-321). Delay per retry: the server's `Retry-After` if present (`err.retry_delay()`, codex-rs/protocol/src/error.rs:403-405), else exponential backoff `200 ms · 2^(n-1)` with ±10 % jitter (codex-rs/core/src/util.rs:6-7, 86-91).
- **Which errors:** classified structurally, not by string-matching — `CodexErr::is_retryable` returns true for `Stream`, `Timeout`, `RequestTimeout`, `UnexpectedStatus`, `ResponseStreamFailed`, `ConnectionFailed`, `InternalServerError`, `Io`, `Json`, etc., false for aborts, auth, quota, context-window, invalid-request (codex-rs/protocol/src/error.rs:362-398).
- **Restart or resume?** Better than either naive answer: the retry does **not** replay the original request blind — it rebuilds the prompt from `sess.clone_history()`, i.e. the session history including items recorded before the failure, and re-attaches already-executed tool calls so they are not run twice (`attach_pending_to_prompt`, turn.rs:1354-1367). So a stream that dies after a tool call resumes the *turn* from recorded state; only the failed HTTP response itself is re-requested.
- **UI truthfulness:** each retry emits `EventMsg::StreamError` ("the system is handling it (e.g., retrying with backoff)", codex-rs/protocol/src/protocol.rs:1427-1429) via `notify_stream_error` (responses_retry.rs:113-121; core/src/session/mod.rs:4028). Exhaustion is a typed terminal error, `ResponseTooManyFailedAttempts` (protocol.rs:1788-1791).
- **Extras with no Cersei analogue:** after the websocket transport exhausts its budget the client falls back to HTTPS and resets the retry count (responses_retry.rs:88-103), and a feature-gated mode retries pure connection failures indefinitely at 5 s→60 s exponential delay ("Reconnecting... waiting for network", responses_retry.rs:17-18, 58-85).

**Request-level HTTP retry** — a generic `RetryPolicy { max_attempts, base_delay, retry_on }` with per-class flags (429 / 5xx / transport) and the same jittered exponential backoff, in codex-rs/codex-client/src/retry.rs:7-48; the provider config maps `request_max_retries` into it with `retry_5xx` and `retry_transport` on (codex-rs/model-provider-info/src/lib.rs:269-283).

### B3. SSE / UTF-8 stream decoding

Codex does **not** have the Cersei bug class. The byte stream is parsed by the `eventsource-stream` crate v0.2.3 (`stream.eventsource()`, codex-rs/codex-api/src/sse/responses.rs:15, 539; dep at codex-rs/Cargo.toml:333, locked at Cargo.lock:6174-6176). That crate feeds all bytes through a `Utf8Stream` (eventsource-stream-0.2.3/src/event_stream.rs:9, 136, 148) whose decoder is incremental and lossless across chunk boundaries: it appends the chunk to a buffer, attempts `String::from_utf8`, and on failure at `valid_up_to()` **splits off the incomplete trailing multi-byte sequence and carries it into the buffer for the next chunk** instead of lossily replacing it (eventsource-stream-0.2.3/src/utf8_stream.rs:58-72). Only at stream end is a genuinely truncated sequence an error. There is no `from_utf8_lossy` anywhere on the codex SSE path (grep of codex-rs/codex-api/src: zero hits). Event payloads are then `serde_json::from_str` per complete SSE event, with malformed events logged and skipped rather than corrupting the stream (responses.rs:573-585). This is the same fix shape Atlas had to vendor-patch into `cersei-provider` (the `incremental-utf8-v1` guard, vendor/cersei-provider/src/utf8.rs:15; src-tauri/src/lib.rs:22-26) — upstream codex simply never had the bug.

### B4. Timeouts and reconnect

- **Stream idle timeout:** every SSE poll is wrapped in `timeout(idle_timeout, stream.next())`; expiry sends `ApiError::Stream("idle timeout waiting for SSE")` (codex-rs/codex-api/src/sse/responses.rs:544-568). Default 300 000 ms, provider-configurable (`stream_idle_timeout_ms`; codex-rs/model-provider-info/src/lib.rs:25, 132, 323-327). The resulting stream error is retryable (B2), so a stalled stream is torn down and the turn retried — this is precisely the "model stalls mid-turn" behavior Atlas's audit found missing.
- **Premature close:** a stream ending before `response.completed` is a distinct error ("stream closed before response.completed", responses.rs:556-561), also feeding the retry loop.
- **Connect timeouts:** websocket connects have a 15 s default (`DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS`, model-provider-info/src/lib.rs:28, 330-335); the HTTP client builder supports `connect_timeout` and per-request `timeout` (codex-rs/http-client/src/client_builder.rs:34, 104, 289; client.rs:221-222; request.rs:83). I did not find a default *overall* deadline on the streaming POST itself — protection there is the idle timeout plus connection-error retry, not a wall-clock cap; saying more would be inference.
- **Reconnect/resume mid-stream:** there is no byte-offset resume of a broken SSE body (no `Last-Event-ID` usage found in codex-rs/codex-api). Reconnection is the B2 machinery: re-request from session history, with websocket→HTTPS transport fallback and the optional unbounded connection-retry mode (responses_retry.rs:58-103).

### Verdict on the reliability claim

**SUPPORTS.** ADR-0003's premise (docs/adr/0003-codex-fork-as-native-agent.md:11) — that codex "already ships the reliability machinery the full-app audit found missing... clean cancellation, retry on failure" — is what the source shows: a single-token cancel that verifiably reaches both the in-flight HTTP future (dropped via `or_cancel`) and the child process group (TERM→KILL), with rollout-consistent abort events; and a two-layer retry stack with structural error classification, backoff+jitter, `Retry-After`, transport fallback, and history-based turn resumption that avoids re-running tool calls.

On the "Atlas lacks" side, stated precisely: the Cersei path's cancel needed a vendored fork to be race-free at all (`ATLAS_CANCEL_PATCH = "tool-cancel-race-v1"`, vendor/cersei-agent/src/lib.rs:27), and its cancel-token installation ordering bug is documented in Atlas's own code (crates/atlas-cersei/src/lib.rs:577-582). Retry is **not** absent — but it exists only as an Atlas-authored patch inside the vendored fork (`ATLAS PATCH (retry-classified-v1)`, vendor/cersei-agent/src/retry.rs:1-16, loop at vendor/cersei-agent/src/runner.rs:388-424), and it classifies errors by substring-matching stringified messages (retry.rs:12-16, 49) where codex matches typed error variants. The turn is also fully re-sent rather than resumed from recorded state. So the accurate form of the claim is not "Atlas has nothing" but ADR-0003's actual claim: everything Atlas has on this front, it built and must maintain by forking someone else's crate — and codex ships a stronger version of the same machinery in code Atlas would own outright. The strongest single caveat: none of this machinery has run a single turn against Atlas's providers; the retry/cancel quality transfers only if the port keeps the `codex-api`/turn-loop path intact (which the integration-surface doc's in-process recommendation does).

---

## Open questions

1. **Pre-cutover native transcript migration (A1.3).** Whether to write a `cersei-sessions/*.json` → codex-rollout converter at cutover, or let old native rows open without replay. The source defines the two formats but cannot make the call.
2. **`memory_timeline` and Memory ▸ Chat coverage of native sessions (A3/A4).** Both currently read Cersei's session files directly (memory_timeline.rs:131; agent_memory.rs:434-460). The codex replacement source (rollouts? the thread-metadata store? nothing?) is a design decision.
3. **Whether the native BYOK path is live-broken today (A2).** Code shows `byok-keys.json` has readers but no writers; I did not run the app to confirm a fresh install's native agent fails with "No API key configured". If confirmed, the cutover *fixes* a latent break rather than risking one — worth one manual test before relying on that framing.
4. **`session_effort` mapping** (carried from the integration-surface doc): codex has reasoning-effort settings, but the exact call the rewritten `SessionEffort` sub-trait body should make was not pinned to a file:line.
5. **Overall request deadline (B4):** whether any layer imposes a wall-clock cap on a single streaming request beyond idle-timeout + retries was not established; if Atlas wants one, it may need to add it at the `Request::timeout` seam (codex-rs/http-client/src/request.rs:83).
