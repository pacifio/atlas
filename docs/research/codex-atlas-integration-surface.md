# Codex ↔ Atlas integration surface: in-process linking vs spawned app-server

**Sources read at:**
- `~/Codes/codex` @ `42b5f05cef69491bc578901fb324b3c9a278b253` — the exact fork point named in ADR-0003. Citations like `codex-rs/...` and `sdk/typescript/...` are relative to this root.
- `~/Codes/atlas` @ `81764f17a238ecc8f278559e2d82c17ef4bb6aff`. Citations like `crates/...` and `src-tauri/...` are relative to this root.

**Companion doc:** [codex-fork-seam.md](codex-fork-seam.md) established the crate spine (77 crates / ~600k LOC), the Responses-API-only wire format, the BYOK path, and the phone-home rip-outs. Those facts are assumed here, not re-derived.

**Decided context (not re-litigated):** hard fork at `42b5f05`, no upstream tracking; Cersei path deleted; the `atlas-native-agent` seam is not on the delete list (ADR-0003; CONTEXT.md "Retiring the name Cersei"); ACP path untouched.

---

## TL;DR

1. **codex-core is genuinely embeddable as a library.** Runtime construction, signal handling, panic hooks, `process::exit`, env-var mutation and stdio ownership all live in `codex-arg0` and the binary crates, not in the core spine (§1). Exactly one process-level requirement leaks in: sandboxed execution needs an executable that can re-enter itself as a helper (`Config::codex_self_exe`), settable explicitly via `ConfigOverrides` (§1, §5).
2. **But "link codex-core directly" is a path no shipped OpenAI binary takes.** The TUI does not link codex-core; it links `codex-app-server-client` and drives the app-server's typed protocol **in-process over in-memory channels** (`InProcessAppServerClient`) — same contract as the stdio server, no process boundary (§2.3). The only raw-`ThreadManager` consumer in the repo is `thread-manager-sample`, explicitly fenced as a sample (§2.4).
3. **OpenAI's own SDKs split:** the Python SDK spawns `codex app-server --listen stdio://` and speaks the JSON-RPC protocol; the TypeScript SDK spawns `codex exec --experimental-json` **per turn** and speaks the exec event stream — neither links core (§2.4).
4. **The `atlas-native-agent` seam survives.** Everything `src-tauri` calls on the crate is either the `AgentServer`/`AgentConnection` trait surface or three named items (`CERSEI_AGENT_ID`, `session_effort`, `session_compression`). Every impl *body* is Cersei guts and gets rewritten; the trait shape maps cleanly onto codex's thread/turn API (§3).
5. **The event model fits at the adapter, not the UI.** The runtime already hands the seam `session/update`-shaped JSON (`crates/atlas-cersei/src/events.rs:156-159`); a codex adapter does the same mapping from `EventMsg`/item notifications. Every SessionUpdate variant Atlas's thread consumes has a codex source; codex's surplus (~40 event kinds) is droppable or future UI (§4).
6. **Sandboxing works from a GUI app on macOS** — Seatbelt is a pure child-process wrapper around `/usr/bin/sandbox-exec` with zero entitlement or argv0 assumptions, and Atlas's bundle is Hardened-Runtime-only, not App-Sandboxed (§5). Linux/Windows need shipped helper binaries whose paths are injected in code. No-sandbox is first-class (`DangerFullAccess`, `ExternalSandbox`), with two documented caveats.
7. **In-process linking is blocked *today* by two `links=` collisions** — `libsqlite3-sys` 0.30 (Atlas, via rusqlite 0.32) vs 0.37 (codex) and `tree-sitter` 0.26 (atlas-codeindex) vs 0.25 (codex) — both fixable with version bumps. Cost after fixing: +542 packages (+57%), four hand-merged `[patch.crates-io]` git-fork entries, ~40 duplicate-major compiles (§6).
8. **The `=1.4.0` vs `=1.5.0` agent-client-protocol collision that forbade a workspace no longer exists** — the old 1.3 stack is deleted and every remaining consumer pins `=2.0.0`; the header of `crates/atlas-native-agent/src/lib.rs:14-21` is stale documentation (§6.0).
9. **Recommendation: option (a), in-process — linking the fork into src-tauri and driving it through the app-server layer's in-process client, not by spawning a binary** (§Recommendation). Strongest counter-argument: fault isolation — an in-process engine panic kills the whole GUI, where a spawned server dies alone.

---

## 1. Is codex-core usable as a library?

**Yes.** The process-ownership behaviour that would make it hostile to embedding is concentrated in `codex-arg0` and the binary crates, and the spine adopts the embedder's tokio runtime.

### 1.1 The embedding API

- `codex-core-api` is a pure re-export facade: 124 lines, zero logic, "Public facade for thread management APIs built on codex-core" (codex-rs/core-api/src/lib.rs:1), compiled under `#![deny(private_bounds, private_interfaces, unreachable_pub)]` (lib.rs:3). It exports `ThreadManager` (lib.rs:41), `CodexThread` (lib.rs:29), `NewThread` (lib.rs:34), `StartThreadOptions` (lib.rs:38), `EventMsg`/`Op` (lib.rs:116-117), `Config` (lib.rs:49), and the auth seam — `AuthManager`, `CodexAuth`, `ExternalAuth` + refresh types (lib.rs:87-92), so an embedder can supply its own token source instead of `~/.codex/auth.json`. The only process-level items it re-exports are `Arg0DispatchPaths`/`arg0_dispatch_or_else` (lib.rs:8-9); `codex-arg0` is a dependency of core-api (codex-rs/core-api/Cargo.toml:18) but **not** of codex-core (absent from codex-rs/core/Cargo.toml).
- `thread-manager-sample` demonstrates exactly the in-process embedding: `main()` wraps `arg0_dispatch_or_else(run_main)` (codex-rs/thread-manager-sample/src/main.rs:88-90 — the only process-owning line, and it comes from arg0, not core), then builds a `Config` literal, opens the state DB, constructs `AuthManager::shared_from_config` (main.rs:119-120), builds `ExecServerRuntimePaths::from_optional_paths(config.codex_self_exe, config.codex_linux_sandbox_exe)` (main.rs:121-124), and calls `ThreadManager::new(...)` with 14 injected collaborators (main.rs:142-157), `start_thread` (main.rs:159-164), then a turn.
- The turn loop is a plain async pull: `start_turn_if_idle(TurnInputRequest::user_input(...))` (main.rs:326-332), then `thread.next_event()` in a loop (main.rs:339-340), terminating on `TurnComplete`/`Error`/`TurnAborted` and surfacing approval events (`ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `RequestPermissions`, `RequestUserInput`, main.rs:390-416 — the sample `bail!`s on them; a GUI renders dialogs).
- The real ergonomic cost is `Config`: ~130 lines of literal struct initialization with no `Default` (main.rs:187-317). Everything Atlas cares about is a field: `ephemeral: true` (main.rs:265), `check_for_update_on_startup: false` (main.rs:311), `analytics_enabled: Some(false)` (main.rs:313).

### 1.2 The thread API proper

There is no public `Codex::spawn`; `Session::spawn` is `pub(crate)` (codex-rs/core/src/session/mod.rs:458). The public shape is:

- `ThreadManager::new` — a plain non-async fn, no runtime handle taken, pure dependency injection of `Arc<dyn Trait>` collaborators (codex-rs/core/src/thread_manager.rs:414-429); `start_thread` (thread_manager.rs:874), `resume_thread_from_rollout` (thread_manager.rs:938), `resume_thread_with_history` (thread_manager.rs:958), `remove_thread` (thread_manager.rs:1039).
- `CodexThread` (codex-rs/core/src/codex_thread.rs:166-174; ctor `pub(crate)` at 193-209, so all creation goes through the manager): `submit(op)` (codex_thread.rs:211-213), `start_or_steer_turn` (283-289), `start_turn_if_idle` (295), `steer_turn` (351), single-consumer `next_event()` (486-488). **Interrupt is `thread.submit(Op::Interrupt)`** — `Op::Interrupt` at codex-rs/protocol/src/protocol.rs:544, yielding `TurnAbortReason::Interrupted` (protocol.rs:3970). `Op::RecoverTurn` ("Resume an interrupted regular turn", protocol.rs:575-579) exists for turn recovery. GUI-relevant accessors: `agent_status` (codex_thread.rs:490), `token_usage_info` (513), `rollout_path` (570), `config_snapshot` (647), `refresh_runtime_config` (698 — live config reload).

### 1.3 Process-ownership audit of the spine

| Concern | Finding | Where |
|---|---|---|
| Tokio runtime construction | **Not in core.** Built by `arg0` (`build_runtime`, multi-thread, 16 MiB stacks — codex-rs/arg0/src/lib.rs:287-292; own OS thread "codex-main" at lib.rs:230-240). Zero `#[tokio::main]`/`Runtime::new` non-test hits in core, codex-api, login, analytics, sandboxing. Core captures **your** runtime: `tokio::runtime::Handle::current()` at codex-rs/core/src/session/session.rs:1251, stored at codex-rs/core/src/state/service.rs:70. | spine-clean |
| `block_on`/`block_in_place` | Guardian review spawns a dedicated OS thread and `block_on`s the captured handle there (codex-rs/core/src/guardian/review.rs:731-744) — embedder-safe. `codex-otel`'s HTTP-client builder is explicitly runtime-flavor-aware (codex-rs/otel/src/otlp.rs:74-91, comment at 71-73). Zero `block_in_place` in core/src non-test. | spine-clean |
| Signal handlers | **One hit in the spine:** every shelled-out tool call's output consumer has a `tokio::select!` arm on `tokio::signal::ctrl_c()` that kills the child process group (codex-rs/core/src/exec.rs:1061, in `consume_output` 968-973). This installs a process-wide SIGINT listener via tokio's global signal driver; no config knob. It does **not** exit the process (`synthetic_exit_status`, exec.rs:1064) and is inert in a GUI with no controlling terminal. All other signal handling is in binaries/helpers (e.g. codex-rs/app-server/src/lib.rs:204-218; raw `libc::sigaction` only in codex-rs/linux-sandbox/src/linux_run_main.rs:775,828,841-846). | one benign leak |
| Panic hooks | Only the TUI: codex-rs/tui/src/lib.rs:1331 and codex-rs/tui/src/tui.rs:543 — the repo's only two non-test hits. | binaries only |
| `process::exit` | Zero in core/codex-api/login/otel/analytics/sandboxing. All hits are in arg0 helper-mode branches (codex-rs/arg0/src/lib.rs:75-151) and exec-server child-helper mains (codex-rs/exec-server/src/arg0_exec_helper.rs:15-30). | binaries only |
| Env-var mutation | **Zero `env::set_var`/`remove_var` in the spine non-test.** All in arg0 pre-thread (`PATH` mutation at codex-rs/arg0/src/lib.rs:163-169, dotenv at 315-317, `CODEX_*` guard at 294-299). This is the biggest hazard **only if** Atlas calls `arg0_dispatch_or_else` (set_var is UB after threads spawn) — so don't call it (§1.4). | binaries only |
| stdio ownership | core/src has zero `println!`/stdin/stdout non-test. Narrow exceptions in login's device-code prompt (codex-rs/login/src/device_code_auth.rs:162) and OAuth-server error paths (login/src/server.rs:199,337,379) — dormant under BYOK. | spine-clean |
| Process hardening | `pre_main_hardening` (codex-rs/process-hardening/src/lib.rs:12-25) is depended on by exactly two crates, neither in the spine: responses-api-proxy (main.rs:6) and linux-sandbox (proxy_lifecycle.rs:124). Not even cli/tui/app-server call it. | not in spine |
| Process-global statics | `login`: `ORIGINATOR`/`USER_AGENT_SUFFIX` (codex-rs/login/src/auth/default_client.rs:39,51 — one originator per process; fine for a single-purpose app). `otel`: installs OTel globals only via `build_provider` (codex-rs/core/src/otel_init.rs:16-21), which is called **only from binaries** (e.g. codex-rs/app-server/src/lib.rs:592) — never triggered by core; Atlas's tracing setup is untouched if it never calls it. Core's own statics are benign gauges/caches (codex_thread.rs:69; core/src/tasks/mod.rs:68). | acceptable |
| `current_exe()` re-exec | Core never calls `std::env::current_exe()` in production; it threads `config.codex_self_exe` into `ExecServerRuntimePaths` (codex-rs/exec-server/src/runtime_paths.rs:7-13), whose constructor **errors if `codex_self_exe` is None** ("Codex executable path is not configured", runtime_paths.rs:16-27). Re-exec sites: fs-sandbox helper (codex-rs/exec-server/src/fs_sandbox.rs:120,133-135), Unix arg0 exec helper (exec-server/src/process_sandbox.rs:197-213), Linux bwrap seccomp re-entry (process_sandbox.rs:161-171). | **the one hard leak** |

### 1.4 Embedding recipe (what the evidence supports)

Depend on `codex-core-api`; do **not** call `arg0_dispatch_or_else`; run under a multi-thread tokio runtime (core declares tokio `rt-multi-thread` and friends at codex-rs/core/Cargo.toml:112-118; Tauri's default runtime is multi-thread); hand-build `Config` as the sample does; run one `next_event()` loop per thread; interrupt via `submit(Op::Interrupt)`. For the self-exe requirement, either ship a helper sidecar binary and set `Config::codex_self_exe` to it, or point it at Atlas's own executable and add a fast argv-sentinel dispatch at the top of `main()` mirroring codex-rs/arg0/src/lib.rs:60-152 **without** the dotenv/PATH tail (lib.rs:154-171), before Tauri initializes.

---

## 2. The two options, compared honestly

### 2.1 Option (a): link in-process inside src-tauri

**Atlas must build:** the `Config` assembly (BYOK provider per codex-fork-seam.md §3), the collaborator set `ThreadManager::new` wants (14 args — auth manager, thread store, environment manager, extension registry, etc., codex-rs/thread-manager-sample/src/main.rs:116-157), the event-forwarding loop into `atlas-native-agent`'s sink, approval-dialog plumbing, and the argv-sentinel or sidecar for `codex_self_exe`. Plus the dependency-graph surgery of §6.

**Atlas gets free:** the whole engine in the same address space — session/turn loop, tool dispatch, retries, rollout persistence (`rollout_path`, codex-rs/core/src/codex_thread.rs:570), resume (`resume_thread_from_rollout`, thread_manager.rs:938), token accounting (513), live config reload (698), typed events with compile-time checking against the same commit. No IPC framing, no child-process lifecycle, no version skew between app and engine.

**Cancel/interrupt path:** `CerseiConnection::cancel` equivalent becomes `thread.submit(Op::Interrupt)` (codex-rs/protocol/src/protocol.rs:544) → core submission loop → `interrupt(&sess)` (codex-rs/core/src/session/handlers.rs:527-529) → `EventMsg::TurnAborted { reason: Interrupted }` (protocol.rs:1448, 3970). One async hop, all in-process.

**Model stalls mid-turn:** core's own machinery handles it — `StreamError` notifications while retrying with backoff (protocol.rs:1427-1429), terminal `ResponseTooManyFailedAttempts` (protocol.rs:1788-1791), and the turn is always interruptible because the submission channel is in-process. `Op::RecoverTurn` (protocol.rs:575-579) exists to resume an interrupted turn. The catastrophic case is inverted, though: if the *engine* (not the model) wedges or panics, it does so inside the GUI process.

### 2.2 Option (b): spawn the app-server binary, speak JSON-RPC

**The protocol** (all in codex-rs/app-server-protocol/src/protocol/common.rs unless noted): not true JSON-RPC 2.0 — "We do not do true JSON-RPC 2.0, as we neither send nor expect the `jsonrpc` field" (codex-rs/app-server-protocol/src/rpc.rs:1). ~150 client→server methods generated by `client_request_definitions!` (common.rs:487): `initialize` (488), `thread/start` (505), `thread/resume` (511), `thread/fork` (517), `thread/list` (691), `thread/read` (735), `turn/start` (918), `turn/steer` (924), `turn/interrupt` (930), `model/list` (977), `review/start` (971), plus config/fs/process/command/skills/hooks/plugins/MCP families (760-1299). Nine server→client requests, including the approval surface: `item/commandExecution/requestApproval` (1596), `item/fileChange/requestApproval` (1603), `item/permissions/requestApproval` (1621), `item/tool/requestUserInput` (1609), `mcpServer/elicitation/request` (1615). ~80 server→client notifications (1747-1862): `thread/started` (1750), `turn/started` (1771), `turn/completed` (1773), `item/started` (1777), `item/completed` (1780), `item/agentMessage/delta` (1785), `thread/tokenUsage/updated` (1770), `thread/compacted` (1816). Transports: stdio JSONL default, unix socket, experimental websocket (codex-rs/app-server-transport/src/transport/mod.rs:75-79; codex-rs/app-server/README.md:24-30). **No protocol-version negotiation**: `InitializeParams` carries clientInfo+capabilities only (codex-rs/app-server-protocol/src/protocol/v1.rs:29,48,68); versioning is "the binary version + its generated schema" (app-server/README.md:59) plus a per-connection `experimentalApi` capability gate (README.md:2452-2511).

**Atlas must build:** process supervision (spawn, health, restart), a JSON-RPC client with request/response correlation and the server→client request direction (approvals arrive as *requests Atlas must answer*), schema types (generated TS/JSON-schema exist upstream, but Atlas's client is Rust — it would consume `codex-app-server-protocol` as a dependency anyway, pulling much of the same graph), reconnect-and-resume logic (none exists client-side: on close/error the remote worker emits `AppServerEvent::Disconnected` and exits — codex-rs/app-server-client/src/remote.rs:410-455 — with zero retry/backoff; in-flight requests fail "remote app-server worker channel is closed", remote.rs:469-648), and the sidecar packaging of the server binary itself (which is the fork, so Atlas builds and ships it either way).

**Atlas gets free:** everything the app-server layers on top of core — thread persistence/listing with cursor pagination and filters (`thread/list` common.rs:691, README.md:168), `thread/read`/`turns/list`/`items/list` (735-748), search (718), resume/fork with interruption markers (511/517, README.md:165-166), archive/delete/rollback/revert (523-686), the full approvals flow with decision vocabulary accept/acceptForSession/decline/cancel (README.md:1684-1704), auth status, model listing, MCP management. Crash containment: a dead server never takes the GUI with it.

**Cancel/interrupt path:** wire `turn/interrupt` (common.rs:930) → `ClientRequest::TurnInterrupt` (codex-rs/app-server/src/message_processor.rs:1380) → `turn_interrupt_inner`: validates the turn id, records a pending interrupt, `submit_core_op(..., Op::Interrupt)` (codex-rs/app-server/src/request_processors/turn_processor.rs:1448-1483) → `CodexThread::submit_with_trace` (codex-rs/core/src/codex_thread.rs:266) → the same core handler (handlers.rs:527-529). The JSON-RPC response is deliberately deferred until `TurnAborted` actually arrives (codex-rs/app-server/src/bespoke_event_handling.rs:1572) — a well-designed async contract, but it now crosses a process boundary both ways.

**Model stalls mid-turn:** same core retry machinery, observed through `StreamError` notifications. The new failure mode is the *server process* stalling or dying mid-turn: the client gets `Disconnected` (codex-rs/app-server-client/src/lib.rs:103) and nothing else — no reconnect, no in-place recovery; Atlas must respawn, re-`initialize` (mandatory handshake, README.md:78,87), and `thread/resume` or `thread/fork`; the interrupted turn's in-flight state is not preserved. There is also a load-shedding path Atlas must handle: JSON-RPC `-32001` "Server overloaded; retry later" with client-side backoff expected (README.md:53-55).

### 2.3 The finding that reframes the choice: the in-process app-server client

The dichotomy "library vs protocol" is not how upstream ships it. The TUI — OpenAI's flagship consumer — does **not** link codex-core (no codex-core dep in codex-rs/tui/Cargo.toml; zero `ThreadManager`/`CodexThread` hits in tui/src). It links `codex-app-server-client` (tui/Cargo.toml:30) and starts the app-server **inside its own process**: `InProcessAppServerClient::start` (codex-rs/tui/src/lib.rs:559, client_name "codex-tui" at 573) → `AppServerClient::InProcess` (lib.rs:487). `codex exec` does the same (codex-rs/exec/src/lib.rs:805). The in-process transport "runs the existing MessageProcessor and outbound routing logic on Tokio tasks, but replaces socket/stdio transports with bounded in-memory channels" (codex-rs/app-server/src/in_process.rs:1-6); it is "transport-local but not protocol-free… responses still come back through the same JSON-RPC result envelope… keeps in-process behavior aligned with app-server rather than creating a second execution contract" (in_process.rs:20-24), and it deliberately routes Rust embedders this way (in_process.rs:34-38). The client facade "intentionally preserves the server's request/notification/event model instead of exposing direct core runtime handles" (codex-rs/app-server-client/src/lib.rs:305-309). Requests go in as **typed Rust values**, not serialized bytes (codex-rs/app-server-client/README.md:31-39).

So option (a) has two sub-layers:

- **(a1) raw `ThreadManager`** via codex-core-api — maximum directness, no envelope at all, but a surface no shipped binary exercises;
- **(a2) `InProcessAppServerClient`** — same process, in-memory channels, typed requests, and the exact contract the TUI and `codex exec` battle-test daily, including the interrupt path, the approval routing, and the thread-listing/resume machinery of §2.2's "free" column — without any of §2.2's process-boundary failure modes.

### 2.4 Which path does OpenAI treat as supported?

- **Python SDK**: a real app-server client — "Synchronous typed JSON-RPC client for codex app-server over stdio" (sdk/python/src/openai_codex/client.py:213), spawning `codex app-server --listen stdio://` (client.py:252,260).
- **TypeScript SDK** (`@openai/codex-sdk`, sdk/typescript/package.json:2): "wraps the codex CLI… spawns the CLI and exchanges JSONL events over stdin/stdout" (sdk/typescript/README.md:5) — but it spawns `["exec", "--experimental-json"]` (sdk/typescript/src/exec.ts:87, spawn at 181), **one process per turn**, stdin closed after the prompt (exec.ts:192-194), speaking the exec event schema (`thread.started`/`turn.completed`/`item.*`, sdk/typescript/src/events.ts:1-69 — "based on event types from codex-rs/exec/src/exec_events.rs"), with no approvals callback and cancellation by killing the child (exec.ts:181-183). This is the *lowest*-fidelity surface, not a model for Atlas.
- **VS Code extension / TUI / exec**: app-server protocol (stdio for the extension per app-server/README.md; in-process for TUI/exec per §2.3). `codex-app-server-client`'s README states its purpose: "Shared in-process app-server client used by conversational CLI surfaces: codex-exec, codex-tui" (codex-rs/app-server-client/README.md:3-5).
- **Raw core linking is load-bearing nowhere shipped.** The only consumer is `codex-thread-manager-sample`, whose manifest fences it: "Keep this sample limited to a single Codex workspace dependency… Add new Codex surface area to codex-core-api instead" (codex-rs/thread-manager-sample/Cargo.toml:12-14).

**Conclusion:** the supported embedding contract is *the app-server protocol*; the supported way to consume it from Rust without a process boundary is *in-process*, and that combination is exactly what upstream's own frontends ship.

---

## 3. The fate of the seam (`crates/atlas-native-agent`)

### 3.1 What src-tauri actually calls on this crate

Grep of src-tauri for the crate's exports finds exactly these dependencies:

- `CerseiAgentServer::new(config_dir)` + `.runtime()` at construction (src-tauri/src/commands/agent_host.rs:296-298), then held as `Arc<dyn atlas_agent_servers::AgentServer>` — i.e. the *trait*, not the type.
- `CERSEI_AGENT_ID` for native-vs-ACP routing (agent_host.rs:437, 452, 492, 1852; src-tauri/src/commands/agents.rs:154; src-tauri/src/commands/catalog.rs:366-401; src-tauri/src/commands/capture.rs:2138).
- A concrete-type downcast for the two native-only knobs: `native_connection()` downcasts `Arc<dyn AgentConnection>` to `CerseiConnection` (agent_host.rs:1045-1048), then `session_effort` (agent_host.rs:1025) and `session_compression` (agent_host.rs:1037).
- A retained `CerseiRuntime` handle used for direct history calls: `native_runtime.list_sessions(cwd)` (agent_host.rs:376) and `delete_session` (agent_host.rs:396) — bypassing the connection's own `AgentSessionList`.

Everything else flows through `AgentServer` (crates/atlas-agent-servers) and `AgentConnection` (crates/atlas-acp-thread/src/connection.rs:182-292).

### 3.2 Classification of the crate, part by part

**(ii) Contract src-tauri depends on — KEEP:**

| Item | Where |
|---|---|
| `AgentServer` impl: `connect()` registering an in-process agent, no child process, delegate ignored | crates/atlas-native-agent/src/server.rs:61-93 |
| `CERSEI_AGENT_ID` (the stored-session id `"cersei"` must keep resolving — server.rs:26-28 says so explicitly) | server.rs:28 |
| `AgentConnection` impl surface: `new_session` (218), `load_session` (250), `close_session` (286), `auth_methods` = `&[]` for BYOK (303), `prompt` (312), `cancel` (331), `session_modes` (337), `model_selector` (349), `session_list` (358) | crates/atlas-native-agent/src/connection.rs:205-368 |
| The sink pattern: engine events rendered onto `AcpThread` via `handle_session_update` / `request_tool_call_authorization` / `update_token_usage` / `upsert_context_compaction` / `report_retry` | crates/atlas-native-agent/src/sink.rs:151-304 |
| `session_effort` sub-trait (connection.rs:101, 386-389) — src-tauri calls it (agent_host.rs:1025); codex has reasoning-effort settings, so this survives with a new body | connection.rs:101-111 |

**(i) Cersei-specific guts — DELETE or REPLACE:**

| Item | Where | Replacement |
|---|---|---|
| Every `CerseiRuntime` call: `spawn`/`new_session`/`load_session`/`send_prompt`/`cancel_turn`/`set_model`/`set_session_mode`/`kill`/`respond_permission` | connection.rs:75, 224, 263, 324, 333, 374, 452, 495; sink.rs:212-224 | codex thread/turn API (`thread/start`, `turn/start`, `turn/interrupt`, approvals responses) |
| `mark_turn_started` turn-epoch stamping (a workaround for the old actor mailbox; the sink already notes it is unnecessary in-process — sink.rs:152-156) | connection.rs:320-322 | codex turns carry real `turn_id`s (protocol.rs:1995-1996) |
| `session_compression` (RTK tool-output compression) + `NativeSessionEvent::CompressionSaved` | connection.rs:114-124, 392-394; sink.rs:26-31, 270-281 | **no codex counterpart — dies with Cersei** (and its src-tauri command with it) |
| Per-cwd session storage: `last_listed_cwd` hack (documented at connection.rs:48-57), cwd-scoped `list_sessions`/`delete_session` | connection.rs:529-594 | codex threads are stored centrally with list filters/pagination (common.rs:691; sqlite state db) — the hack becomes unnecessary |
| `ReplayItem`-based transcript replay | connection.rs:650-690 | `thread/read` / `resume_thread_from_rollout` replay (thread_manager.rs:938) |
| Text-only prompt flattening (`flatten_text`) and `PromptCapabilities::default()` | connection.rs:143, 615-638 | codex `UserInput` accepts richer content; capabilities can widen (a UI improvement, not an obligation) |
| src-tauri side guts: direct `native_runtime.list_sessions/delete_session` (agent_host.rs:376, 396), `TranscriptKind::CerseiJson` (agent_host.rs:2340), `Source::Cersei` (capture.rs:2138), display name "Cersei" (agent_host.rs:492-494) | — | re-route through the connection / rename per ADR-0003 |

### 3.3 Does codex force a different shape?

No. The trait's verbs — create/load/close session, prompt returning a stop reason, fire-and-forget cancel, modes, model selector, session list — all have direct codex equivalents (§2). Two omissions documented in the module header (crates/atlas-native-agent/src/lib.rs:23-32) actually *improve*: `AgentSessionTruncate` was omitted because Cersei's runtime "stores neither" the id-to-history mapping — codex has `thread/rollback` (common.rs:680) and `ThreadRolledBack` (protocol.rs:1324), so truncate becomes implementable; elicitations were omitted because Cersei never elicits — codex *can* (`ElicitationRequest`, protocol.rs:1416, from MCP servers), so the seam gains a case the ACP stack already knows how to render. One genuine mismatch is subtractive, not structural: `session_compression` loses its engine. **Verdict: the interface survives; every impl body is rewritten.** (The crate's header note that it "could fold into atlas-cersei" is moot — atlas-cersei is deleted; and its 1.3-vs-2.0 rationale is stale, see §6.0.)

---

## 4. Event model fit

### 4.1 What Atlas's UI consumes today

The runtime hands the seam `session/update`-shaped JSON (`NativeEvent::SessionUpdate`, crates/atlas-cersei/src/events.rs:156-159, rationale at events.rs:17-21) plus five out-of-band events (`PermissionRequest`, `Usage`, `Compaction`, `CompressionSaved`, `Retry` — events.rs:153-188). The sink deserializes updates into `acp::SessionUpdate` and applies them to the thread (crates/atlas-native-agent/src/sink.rs:158-179). `AcpThread` handles exactly these variants (crates/atlas-acp-thread/src): `AgentMessageChunk`, `AgentThoughtChunk`, `UserMessageChunk`, `ToolCall`, `ToolCallUpdate`, `Plan`, `AvailableCommandsUpdate`, `ConfigOptionUpdate`, `CurrentModeUpdate`, `SessionInfoUpdate`, `UsageUpdate` — plus the direct methods `request_tool_call_authorization`, `update_token_usage`/`update_cost`, `upsert_context_compaction`, `report_retry` (sink.rs:198, 242-252, 268, 293).

### 4.2 Mapping table

Codex side: `EventMsg` (codex-rs/protocol/src/protocol.rs:1285-1470, ~75 variants) and `TurnItem` (codex-rs/protocol/src/items.rs:44-75, 18 item types), surfaced through `ItemStarted`/`ItemCompleted` (protocol.rs:1462-1463).

**Clean matches (codex → Atlas):**

| Codex | Atlas consumer |
|---|---|
| `AgentMessageContentDelta` (protocol.rs:1467) | `agent_message_chunk` (the exact mapping the Cersei runtime does today, crates/atlas-cersei/src/lib.rs:1106) |
| `ReasoningContentDelta` (1469) / `AgentReasoning` (1351) | `agent_thought_chunk` (lib.rs:1110) |
| `ItemStarted`/`ItemCompleted` for `CommandExecution`, `FileChange`, `McpToolCall`… (items.rs:44-75) + `ExecCommandBegin/End` (1393/1401), `PatchApplyBegin/End` (1433/1439), `McpToolCallBegin/End` (1380/1382), `WebSearchBegin/End` (1384/1386) | `tool_call` / `tool_call_update` (lib.rs:1255-1288) |
| `PlanUpdate` (1446) / `PlanDelta` (1468) — a first-class plan event | `plan` (Atlas currently *synthesizes* this from TodoWrite calls, lib.rs:1233-1252 — codex's is native) |
| `TokenCount` (1342; `TokenUsageInfo` + `RateLimitSnapshot`, 2154-2157) | `NativeEvent::Usage` → `update_token_usage` (sink.rs:227-252) |
| `ContextCompacted` (1321) + the `ContextCompaction` item (items.rs:74) | `upsert_context_compaction` (sink.rs:254-269) |
| `ExecApprovalRequest` (1406), `ApplyPatchApprovalRequest` (1418), `RequestPermissions` (1408) | `PermissionRequest` → `request_tool_call_authorization` (sink.rs:181-226); decision vocab accept / acceptForSession / decline / cancel (app-server/README.md:1684) ↔ `AllowOnce`/`AllowAlways`/`RejectOnce`/`Cancelled` (crates/atlas-cersei/src/events.rs:112-126) |
| `TurnComplete` (1338) / `TurnAborted { reason: Interrupted }` (1448, 3970) | `PromptResponse` stop reason `end_turn`/`cancelled` (connection.rs:644-647) |
| `UserMessage` (1348) | `user_message_chunk` (replay path) |
| `StreamError` (1429) | `report_retry` — **partial**: `StreamErrorEvent` carries message + error info + details (protocol.rs:3398-3407) but not the `attempt`/`max_attempts`/`delay_ms` that Atlas's `RetryStatus` renders (sink.rs:282-301). Adapter degrades gracefully or the retry card loosens. |

**Atlas events with no codex counterpart:**

- `CompressionSaved` (events.rs:179) — RTK is Cersei-only; dies.
- `Usage.cost` in USD (events.rs:173-174) — codex `TokenCount` reports tokens and rate limits only; Atlas already owns models.dev pricing (CONTEXT.md "Atlas-recorded usage"), so cost moves to Atlas's side or stays `None`.
- `AvailableCommandsUpdate`, `ConfigOptionUpdate`, `SessionInfoUpdate` — no corresponding `EventMsg` variant found; nearest app-server equivalents are request/response (`skills/list` common.rs:760, `thread/name/set` common.rs:557) rather than unsolicited updates. Whether codex pushes anything equivalent was not established from source — flagged, not inferred.
- `CurrentModeUpdate` — codex mode changes are client-driven (`thread/settings/update`, common.rs:624) with `ThreadSettingsApplied` (protocol.rs:1333) as the plausible echo; exact fit unverified.

**Codex events with no Atlas consumer today** (droppable at the adapter, or future UI): `ExecCommandOutputDelta` (1396 — live terminal output streaming; ACP tool-call content could carry it), `TerminalInteraction` (1399), `TurnDiff` (1441), `RequestUserInput` (1410), `ElicitationRequest` (1416), `DynamicToolCall*` (1412-1414), guardian/moderation family (`GuardianWarning` 1294, `GuardianAssessment` 1421, `SafetyBuffering` 1318, `TurnModerationMetadata` 1315, `ModelReroute` 1309, `ModelVerification` 1312), `Realtime*` voice family (1297-1306, 1444), `EnvironmentConnected/Disconnected` (1363-1366), `ThreadGoalUpdated` (1369), `ThreadQueueChanged` (1372), `McpStartupUpdate/Complete` (1375-1378), `ImageGeneration*` (1388-1390), `ViewImageToolCall` (1404), `EnteredReviewMode`/`ExitedReviewMode` (1454-1457), `ThreadRolledBack` (1324), `DeprecationNotice` (1425), `Warning` (1291), `RawResponseItem/Completed` (1459-1460).

Permission modes: Atlas's four (default / acceptEdits / plan / bypass — built by the runtime at crates/atlas-cersei/src/lib.rs:1351, parsed at 919-937) are adapter-constructible as named pairs of codex `AskForApproval` (protocol.rs:914-925: untrusted / on-request / …) × `SandboxPolicy` (protocol.rs:1001-1035) — codex's own permission profiles do the same bundling (codex-rs/core/src/config/resolved_permission_profile.rs:14-31).

### 4.3 Verdict

**The chat UI does not need to change shape.** The adapter boundary Atlas already built for exactly this purpose — engine events rendered into `acp::SessionUpdate` + a handful of thread methods (sink.rs) — absorbs the codex event model the same way it absorbed Cersei's. Every update kind the UI renders has a codex source; the mismatches are either subtractive (compression), Atlas-computable (cost), or partial-fidelity (retry fields). The large codex surplus is opportunity (terminal streaming, turn diffs, native plans, truncate), not obligation.

---

## 5. Sandbox and process model

### 5.1 macOS: a child-process wrapper, GUI-compatible

Seatbelt is never applied to the current process. The exec path prepends `/usr/bin/sandbox-exec -p <generated .sbpl> -- <argv>` to the tool command (constant hardcoded to defeat PATH injection, codex-rs/sandboxing/src/seatbelt.rs:39, comment 35-38; profile generated in-memory from three embedded `.sbpl` templates, seatbelt.rs:21-26; argv assembly 780-788; wrapper prepended in `SandboxManager::transform`, codex-rs/sandboxing/src/manager.rs:360-389) and spawns it as an ordinary child (codex-rs/sandboxing/src/spawn.rs:42-119). There is **no** `sandbox_init`/`sandbox_apply` on the host process anywhere, and **no** entitlement, codesigning, or hardened-runtime assumption in code (grep confirms none). The one failure mode: if the *host itself* runs under the macOS App Sandbox, `sandbox-exec` fails with `sandbox_apply: Operation not permitted` — recognized in tests (codex-rs/sandboxing/tests/suite/seatbelt_tests.rs:46-50, 173-177) but unhandled at runtime. **Atlas is not App-Sandboxed:** src-tauri/entitlements.plist contains Hardened Runtime exception keys only (JIT, library validation, network, user-selected files) and no `com.apple.security.app-sandbox` key — so the failure condition does not apply to Atlas's shipping configuration.

### 5.2 Linux and Windows: helper binaries, explicitly injectable

- Linux sandboxed exec **requires** a helper binary: `codex_linux_sandbox_exe.ok_or(MissingLinuxSandboxExecutable)` (manager.rs:393-394; error at codex-rs/sandboxing/src/lib.rs:66-68). The parent overrides the child's argv0 to `"codex-linux-sandbox"` (manager.rs:418, 708-714) so the helper's arg0 dispatch fires (codex-rs/arg0/src/lib.rs:95-97) — **the host's own argv0 is irrelevant**. Inside bwrap the helper re-execs `current_exe()` (of the *helper*) for seccomp (codex-rs/linux-sandbox/src/linux_run_main.rs:1440-1461); bwrap comes from PATH or a bundled SHA-256-verified copy (codex-rs/linux-sandbox/src/bundled_bwrap.rs:28-77). If nothing sets the path, every sandboxed Linux exec fails with `MissingLinuxSandboxExecutable`.
- Windows: a helper (`codex-command-runner.exe`) is materialized into CODEX_HOME (manager.rs:507-560; codex-rs/windows-sandbox-rs/src/helper_materialization.rs:29-77); sandbox off by default on Windows unless explicitly enabled (manager.rs:60-73).
- **The injection seam is documented and code-level:** `ConfigOverrides { codex_self_exe, codex_linux_sandbox_exe, main_execve_wrapper_exe }` (codex-rs/core/src/config/mod.rs:2513-2515, applied 3157-3160); `codex_linux_sandbox_exe` "cannot be set in the config file: it must be set in code via ConfigOverrides" (mod.rs:877-882). `Arg0DispatchPaths` is a plain struct of three `Option<PathBuf>` deriving `Default` — hand-constructible without ever calling `arg0_dispatch_or_else` (codex-rs/arg0/src/lib.rs:28-38); the in-process app-server takes it as an explicit argument (codex-rs/app-server/src/in_process.rs:122-124).

### 5.3 Disabling the sandbox is a supported configuration

`SandboxPolicy::DangerFullAccess` ("No restrictions whatsoever", codex-rs/protocol/src/protocol.rs:1002-1004) and `SandboxPolicy::ExternalSandbox` ("the process is already in an external sandbox… full disk access while honoring the provided network setting", protocol.rs:1015-1022) are first-class variants with a user-facing mode (codex-rs/protocol/src/config_types.rs:86-96) and a built-in permission profile (codex-rs/core/src/config/resolved_permission_profile.rs:14-31). The short-circuit is clean: `should_require_platform_sandbox` returns false for unrestricted/external policies (codex-rs/sandboxing/src/policy_transforms.rs:523-543), `select_initial` yields `SandboxType::None` (manager.rs:283-292), and `transform` with `SandboxType::None` passes argv through verbatim — no arg0 override, no helper lookup, so `MissingLinuxSandboxExecutable` cannot fire (manager.rs:358). Sandboxing is **not** inseparable from the tool-exec path: the single layer that applies `SandboxPolicy` to argv is `SandboxManager::transform` (manager.rs:311-455), reached via `SandboxAttempt::env_for` (codex-rs/core/src/tools/sandboxing.rs:425-451) from the tool orchestrator (codex-rs/core/src/tools/orchestrator.rs:236-270). Two caveats where "no sandbox" is overridden: denied-read path policies refuse to drop the sandbox (core/src/tools/sandboxing.rs:274-279), and managed-network policy / guardian auto-review silently upgrades DangerFullAccess to workspace-write (codex-rs/core/src/session/mod.rs:593-616; policy_transforms.rs:528-530).

### 5.4 Exec-server's role

Locally, exec-server is an **in-process** environment abstraction, not a separate daemon: with no remote URL, `Environment::local` wraps a `LocalProcess` executor in the same process (codex-rs/exec-server/src/environment.rs:718-760), which applies the sandbox itself (codex-rs/exec-server/src/process_sandbox.rs:107-118, 240-245) and is where the `codex_self_exe` re-entry lives (fs helper at codex-rs/exec-server/src/fs_sandbox.rs:119-137; Unix exec helper at process_sandbox.rs:198-213). `shell-escalation` needs no TTY (stderr only, codex-rs/shell-escalation/src/unix/execve_wrapper.rs:16-20) and is gated behind a zsh-fork feature flag anyway (codex-rs/core/src/tools/runtimes/shell/unix_escalation.rs:110-122). `process-hardening` never runs in the spine (§1.3).

### 5.5 Bottom line for a Tauri host

macOS (Atlas's primary platform): sandboxing works today from the GUI process with zero helper of Atlas's own — the OS provides `sandbox-exec`. Linux: ship `codex-linux-sandbox` (+ optionally bundled bwrap) as a sidecar and set `ConfigOverrides::codex_linux_sandbox_exe`. Windows: ship the command-runner helper, or keep the default-off behavior. Everywhere: `codex_self_exe` must point at a real re-enterable binary for exec-server's sandboxed modes — a sidecar or Atlas's own exe with an argv sentinel (§1.4). And if Atlas chooses to launch with sandboxing off, that is a supported, cleanly short-circuited configuration, subject to the two §5.3 caveats.

---

## 6. Dependency collision

### 6.0 Premise correction: the workspace blocker is gone

The brief's premise — "Atlas cannot get a workspace because agent-client-protocol `=1.4.0` vs `=1.5.0` collide" — is **no longer true at this commit**. The old 1.3 stack (atlas-acp, atlas-agents, atlas-registry, atlas-agentkit) is deleted; src-tauri/Cargo.toml:58-66 describes the collision in the past tense. Every remaining consumer pins `agent-client-protocol = "=2.0.0"` (crates/atlas-acp-thread/Cargo.toml:13, atlas-agent-servers/Cargo.toml:8, atlas-agent-delta/Cargo.toml:12, atlas-agent-manager/Cargo.toml:12, atlas-native-agent/Cargo.toml:13, atlas-thread-metadata/Cargo.toml:18, src-tauri/Cargo.toml:79), and the lock resolves exactly one of each: `agent-client-protocol@2.0.0`, `-derive@2.0.0`, `-schema@1.5.0` (src-tauri/Cargo.lock:32-69). The dual-stack rationale in crates/atlas-native-agent/src/lib.rs:14-21 is stale documentation. Codex has **zero** `agent-client-protocol` anywhere in codex-rs/Cargo.lock — no collision on that axis. (The `[patch.crates-io]` for `cersei-provider`/`cersei-agent` in src-tauri/Cargo.toml:218-228 also disappears with the Cersei SDK, per ADR-0003.)

### 6.1 Hard blockers today: two `links=` collisions

Cargo forbids two crates with the same `links` key in one graph — these are build errors, not bloat:

- **BLOCKER A — `libsqlite3-sys` (links = "sqlite3"):** codex needs 0.37.0 (workspace pin `libsqlite3-sys = "0.37"`, codex-rs/Cargo.toml:362; reached via codex-core → codex-state, codex-rs/state/Cargo.toml:13, and sqlx 0.9, codex-rs/Cargo.toml:434). Atlas resolves 0.30.1 via `rusqlite = { version = "0.32", features = ["bundled"] }` in three crates (src-tauri/Cargo.toml:48, crates/atlas-checkpoint/Cargo.toml:14, crates/atlas-thread-metadata/Cargo.toml:14) — rusqlite 0.32 hard-wires libsqlite3-sys 0.30. Both sides also bundle vendored SQLite (duplicate `sqlite3_*` symbols even if Cargo allowed it). **Fix: bump Atlas's rusqlite 0.32 → 0.38 in those three crates.**
- **BLOCKER B — `tree-sitter` (links = "tree-sitter"):** codex pins 0.25.10 (codex-rs/Cargo.toml:477; via codex-apply-patch and codex-shell-command, both direct codex-core deps); Atlas uses 0.26.10 (crates/atlas-codeindex/Cargo.toml:14). Also `tree-sitter-bash` 0.25.1 (codex) vs 0.23.3 (Atlas). **Fix: bump the fork's tree-sitter to 0.26, or downgrade atlas-codeindex to 0.25 and re-pin its four grammar crates.**

Non-blocking `links` crates: `ring` 0.17.14 identical; `aws-lc-sys` 0.39 vs 0.41 uses a version-scoped links key and coexists; `zstd-sys` identical; `openssl-sys` appears only under codex's `[target.*-linux-musl]` section (codex-rs/core/Cargo.toml:129-135) — irrelevant on darwin, would bite a musl CI target; `bzip2-sys` differs by major but should be re-checked after A+B are fixed.

### 6.2 Exact pins, patches, git deps

- Codex's exact pins collide with nothing Atlas has: `rmcp = "=3.0.0"` (codex-rs/Cargo.toml:400), `tar = "=0.4.45"` (:452), eight `rama-* = "=0.3.0-alpha.4"` pre-release crates via codex-network-proxy (codex-rs/network-proxy/Cargo.toml:32-47), `tonic-prost-build = "=0.14.3"` as a build-dep of codex-config (codex-rs/config/Cargo.toml:70 — protoc + tonic-build now compile in Atlas's graph). `v8 = "=150.4.0"` (:487) is **not** in codex-core's closure — the biggest thing dodged.
- **`[patch.crates-io]` must be hand-merged:** codex patches `crossterm`, `tokio-tungstenite`, `tungstenite` (+ one `[patch."ssh://…"]` entry) to git forks under openai-oss-forks (codex-rs/Cargo.toml:585-596). `[patch]` is honored only from the workspace-root manifest, so adding codex crates as path deps does **not** import codex's patch table — all four entries must be copied into src-tauri's manifest, or the forked-version requirements become unsatisfiable. Codex's forked tungstenite is 0.27 vs Atlas's existing 0.28 (a duplicate-major, tolerable).
- **Git dependencies enter Atlas's graph for the first time:** `nucleo` (git, helix-editor), `runfiles` (git, rules_rust) (codex-rs/Cargo.toml:370, 401) plus the three patch forks. Atlas currently has zero git deps; this adds network fetches and complicates `--offline`/`cargo vendor`.

### 6.3 Shared-dep skew and scale

- Clean same-major unification: tokio (1.52.3/1.53.1), hyper (1.8.1/1.9.0), rustls 0.23.x, serde/serde_json, tower, tracing, uuid, chrono, time, ring, schemars. reqwest: both sides already carry 0.12 + 0.13 — fine.
- Codex-only additions Atlas has none of today: sqlx 0.9 (+ mysql/postgres/sqlite drivers), the full OTLP stack (opentelemetry* 0.31, tonic 0.14, prost 0.14), axum 0.8, keyring 3.6, the gix suite (~55 crates), aws-* SDK (~20), rama-* (16 alphas), starlark, symphonia, zbus, rmcp.
- Duplicate-major compiles (bloat, not blockers): ~40 pairs — notably zip 2.4 vs 8.6, zbus 4 vs 5, portable-pty 0.9 vs 0.8, plus merged sets of 4 majors each for base64 and rand.
- **Scale:** codex-rs lock = 1,353 packages; Atlas lock = 959. codex-core's closure ≈ 1,010 packages (76 codex-* path crates + externals), of which 467 are already in Atlas's lock → **~542 new packages, 959 → ~1,501 (+57%)**, all 76 codex crates compiled from source on every clean build.
- Toolchain: codex pins stable 1.95.0 (codex-rs/rust-toolchain.toml); Atlas pins nothing. Codex is edition 2024, Atlas 2021 — editions are per-package and coexist. No nightly features. Clean axis.

**Net for the two options:** option (a) requires fixing Blockers A and B, merging four patch entries, and accepting the +57% graph. Option (b) *also* compiles the entire fork (Atlas builds and ships the server binary) — it just does so in a separate target, keeping src-tauri's own graph clean at the price of two build graphs and a sidecar. The collision work is a one-time cost either way if Atlas ever wants the engine in-process; only option (b) can defer it.

---

## Recommendation

**Option (a): in-process.** Link the ported engine into src-tauri — and within (a), drive it at the app-server layer via `InProcessAppServerClient` (typed requests over in-memory channels, codex-rs/app-server/src/in_process.rs:1-38) rather than raw `ThreadManager`, keeping raw core-api as the documented fallback if the app-server layer proves too heavy to own.

**Evidence:**

1. **The library is embeddable and the team's "no fragile protocol hop" preference survives scrutiny.** The spine constructs no runtime, installs no panic hooks, never exits, never mutates env vars, and adopts the host's tokio runtime (§1.3); the one process-level leak (`codex_self_exe`) has an explicit code-level injection seam (§5.2). The fragile parts of a protocol hop — child-process lifecycle, stdio framing, mid-turn server death with *no client-side reconnect whatsoever* (codex-rs/app-server-client/src/remote.rs:410-455), version skew between separately-shipped artifacts — are all real and all disappear in-process.
2. **In-process does not mean off the supported path.** OpenAI's own flagship frontends (TUI, `codex exec`) run the app-server in-process over in-memory channels — the identical `MessageProcessor`, interrupt contract (reply deferred until `TurnAborted`, codex-rs/app-server/src/bespoke_event_handling.rs:1572), and approval routing that external clients get (§2.3). Choosing (a2) means Atlas's daily code path is the same one upstream battle-tested until the fork point, and it inherits the "free" column of option (b) — thread listing/resume/fork, approvals, settings — without the process boundary. Raw `ThreadManager`, by contrast, is exercised by nothing shipped (§2.4).
3. **The seam and the UI both survive unchanged in shape.** `AgentConnection`'s verbs map 1:1 onto the codex surface (§3.3), and the event model adapts entirely inside `atlas-native-agent`'s existing sink boundary (§4.3). Nothing about option (a) forces UI or seam surgery; option (b) wouldn't either — this axis is neutral, so it cannot justify the extra process.
4. **ADR-0003's premise points in-process.** The decision's test is "users still see dropped connections and broken streaming → the engine was never the cause" (docs/adr/0003-codex-fork-as-native-agent.md:29-31). A spawned-binary design re-introduces exactly the class of failure (child process dies, stream stops, UI must reconnect) the port exists to eliminate, and would muddy that reversal test.
5. **The dependency blockers are real but small and bounded:** a rusqlite 0.32→0.38 bump in three Atlas crates, a tree-sitter 0.25/0.26 unification, four copied `[patch]` entries (§6). The +57% package count is the price of owning the engine, which ADR-0003 already accepted; option (b) pays the same compile cost in a second target.

**Strongest argument against (a):** **fault isolation.** In-process, every panic, abort, deadlock, or memory-safety bug anywhere in ~600k LOC of newly-owned engine code — including the 307-`unsafe` Windows sandbox crate and the 91-`unsafe` pty layer flagged in codex-fork-seam.md §5.3 — takes down the entire GUI, the user's unsaved state, and every other agent session with it. A spawned app-server's worst case is a dead child: the UI survives, shows a reconnect affordance, and `thread/resume`/`thread/fork` (with interruption markers, app-server/README.md:165-166) recover the conversation from the rollout on disk. Upstream's own client stack implicitly plans for this (the `Disconnected` event exists; in-process it "should not fire in practice"). Atlas is betting that the engine is stable enough to live in the GUI process — a bet Zed makes with its native agent, but one that a fork's first year, with no upstream fixes flowing, makes genuinely riskier. If post-cutover crash telemetry shows engine panics killing the app, the escape hatch is cheap by design: because (a2) speaks the same protocol as the stdio server, moving the engine out of process later is a transport swap (`AppServerClient::InProcess` → `::Remote` plus supervision), not a rewrite — which is itself a reason to prefer (a2) over (a1) now.

---

## Open questions

1. **Does `InProcessAppServerClient` pull startup behavior Atlas must neutralize?** `run_main_with_transport_options` does otel provider setup, unix-socket lock, and sqlite state-db init (codex-rs/app-server/src/lib.rs:585-608); how much of that the in-process entry (`in_process.rs`, `InProcessStartArgs` at 122-124) performs versus skips was not fully traced. Verify before committing to (a2) over (a1).
2. **The spine's ctrl_c listener** (codex-rs/core/src/exec.rs:1061) installs a process-wide SIGINT arm per tool exec. Believed inert in a GUI (no controlling terminal), but whether it interacts with Tauri's own signal handling on macOS was not tested.
3. **`session_effort` mapping.** Codex has reasoning-effort settings (thread settings / model config); the exact call the adapter should make for Atlas's per-session effort knob (agent_host.rs:1025) was not pinned to a file:line.
4. **Unsolicited update parity** for `AvailableCommandsUpdate` / `SessionInfoUpdate` / `ConfigOptionUpdate` (§4.2): no codex push equivalent was found; whether the app-server notifies on skill/name changes or Atlas must poll was not established.
5. **Rollout/state-db vs Atlas's thread-metadata store (ADR-0001).** Codex brings its own sqlite thread state (codex-rs/state) and rollout files; Atlas's sidebar must remain fed only by the app-owned store. The mapping (ThreadRecorder listening to codex events vs importing from codex's DB) is design work this document does not settle.
6. **Bundled-SQLite double-vendoring** after the rusqlite bump: confirm one `libsqlite3-sys` with `bundled` serves both codex-state/sqlx and Atlas's rusqlite users, honoring codex's ≥3.51.3 compile-time assert (codex-rs/state/src/lib.rs:7-10, per codex-fork-seam.md §5.2).
7. **Windows/Linux helper packaging** (sidecar signing, Tauri bundler integration for `codex-linux-sandbox`/`codex-command-runner.exe`) is unexplored; macOS needs none (§5.5).
8. Inherited from codex-fork-seam.md: default OTel exporter state in release builds, `codex-feedback`/`codex-connectors` network behavior — both are rip-outs regardless of integration surface.
