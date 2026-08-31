# Atlas architecture

Deep technical reference for Atlas. The README has the pitch and feature list; this has the file paths and invariants.

Atlas is a Tauri v2 desktop app: a React 19 frontend talking to a Rust backend over IPC. Almost every real feature crosses the whole stack:

```
src/features/<feature>/components  →  stores (Zustand)  →  lib/*-api.ts (invoke + listen)
                                                                 ↓
                                            src-tauri/src/commands/<domain>.rs
                                                                 ↓
                                                        crates/atlas-*
```

- **The frontend never touches the filesystem or spawns processes.** Everything goes through `invoke()` and `listen()`.
- **Rust owns the heavy, stateful subsystems** — agent sessions, the terminal PTY. The stores that mirror them stay thin.

## High-level layout

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Atlas (Tauri shell)                           │
│                                                                        │
│  ┌─────────────────────────────┐    ┌───────────────────────────────┐ │
│  │  React 19 frontend          │    │  Rust backend                  │ │
│  │  (WKWebView on macOS)       │◀──▶│  (tokio + tauri 2)              │ │
│  │                             │ IPC│                                 │ │
│  │  • Zustand stores           │    │  • commands/ — 354 IPC verbs    │ │
│  │  • CodeMirror, xterm,       │    │    across 69 domain modules     │ │
│  │    Tiptap, Pixi, TanStack   │    │  • ported ACP stack (10 crates) │ │
│  │  • Tailwind v4              │    │  • atlas-cersei (native agent)  │ │
│  │                             │    │  • atlas-terminal (PTY)         │ │
│  │                             │    │  • atlas-memory / atlas-embed   │ │
│  │                             │    │  • spawn_blocking for all I/O   │ │
│  └─────────────────────────────┘    └───────────────────────────────┘ │
│                                                                        │
│  Persistence:                                                          │
│  • Per-project: <project>/.atlas/ (knowledge, canvas.json,             │
│    editor-state.json, logs.jsonl, memory index, codebase-index,        │
│    cloned repos, skills, packs)                                        │
│  • Global:      ~/.atlas/ (pinned log rows),                           │
│                 <app-config-dir>/threads.db (session history)          │
└────────────────────────────────────────────────────────────────────────┘
```

## Frontend (`src/`)

Organized by **feature**, not file type:

```
src/features/<feature>/
  components/   — React components
  stores/       — Zustand store(s) for this feature
  lib/          — pure helpers, and the invoke()/listen() wrappers (<domain>-api.ts)
```

`src/features/` holds ~30 slices: chat, editor, terminal, browser, git, github, explorer, knowledge, canvas, layout, log, monitor, settings, memory, mission-control, model-chat, organisations, packs, skills, telemetry, updater, workspaces, and more.

- **Cross-feature widgets** live in `src/components/`.
- **UI primitives** live in `src/ui/`.
- **Shared helpers** live in `src/lib/`. `@/` aliases `src/`.

### State management

- **Stores are Zustand + Immer**, wrapped in `createSelectors` (`src/lib/create-selectors.ts`), which auto-generates `useStore.use.x()` selectors.
- **Stores never call other stores directly.** Cross-feature coordination happens by reading another feature's state via `getState()` at an action boundary, or by firing `window.dispatchEvent(new CustomEvent("atlas:..."))` for looser coupling. Importing one feature's store into another feature's store module violates this.
- **Tailwind classes compose through `cn()`** (`src/lib/utils.ts`), never concatenated ad hoc.

### The authoritative-state boundary

**Rust — or a native browser API — owns state for every subsystem where performance matters.** The matching Zustand store holds only UI metadata and mirrored deltas.

| Subsystem | Store holds (UI only) | Real state lives in |
|---|---|---|
| Chat | queues, draft text, scroll position (`chat/stores/chat-store.ts`) | the ported thread behind `AgentConnection` — message log, tool calls, run status, projected to the frozen wire and streamed over `atlas:agents` |
| Editor | open-file metadata, dirty flags (`editor/stores/editor-store.ts`) | CodeMirror owns the document text |
| Terminal | split/pane layout (`terminal/stores/terminal-store.ts`) | `atlas-terminal`'s PTY session owns the byte buffer |

This is a deliberate performance boundary, not an oversight to fix by moving more state into the store. Lifting chat messages, document text, or terminal bytes into Zustand degrades streaming, typing, and PTY throughput — every keystroke would touch Immer.

Other stores: `project/stores/project-store.ts` (current project, recents), `git/stores/git-store.ts` (branch, status, lane-assigned commit graph), `log/stores/log-store.ts` (ring-buffered event log, 500 in memory, + on-disk pinned rows), `knowledge/stores/knowledge-store.ts`, `canvas/stores/canvas-store.ts` (ReactFlow nodes/edges), `monitor/stores/usage-store.ts` (token usage per provider/model).

### Tabs and the split-column layout

`layout/stores/layout-store.ts` owns the tab system:

- `addTab` / `closeTab`, per-tab-type dedupe rules.
- **Up to 3 columns** (`groupOrder`, capped at 3). Each tab carries a `groupId` naming its column.
- A maintained `activeTabId` mirrors the focused column's active tab, so most readers don't need to know splits exist.

`src/lib/constants.ts` holds `TAB_TYPES` (the tab-type registry); `src/features/layout/components/center-panel.tsx` holds the lazy-import map keyed off it. New panel type = lazy import in `center-panel.tsx` + entry in `TAB_TYPES` + entry in `NEW_TAB_OPTIONS` if it should reach the `+` menu.

**Persistent module types — editor, terminal, browser, knowledge-graph, pdf — stay mounted across tab switches** via `display: contents` / `display: none` instead of unmounting. Remounting would rebuild CodeMirror instances, kill the PTY's rendered scrollback, or tear down the native embedded webview.

## Backend (`src-tauri/src/`)

One Rust module per IPC domain under `src-tauri/src/commands/`. `commands/mod.rs` declares 69 `pub mod` domain files:

| Domain group | Modules |
|---|---|
| Agents (ported ACP stack) | agents, agent_host, agent_transcript, agent_analytics, agent_memory, catalog, registry, capture |
| Native agent | cersei |
| Terminal / browser / fs | terminal, browser, fs |
| Git | git, git_graph, git_watcher, gitdiff, git_ops, git_conflicts, git_snapshot, git_stage_ops |
| GitHub | github |
| Knowledge | knowledge, knowledge_meta, knowledge_links, knowledge_export, knowledge_graph_layout |
| Memory | memory_* — graph, pack, policy, sharing, summarize, timeline, delta, inject, compile, indexer, retrieve; plus shared_memory |
| Models & usage | models, models_pricing, usage, tool_stats |
| Session chat | session_chat, session_chat_sessions, modelchat |
| Auth & environment | auth, byok, shell_profile, mcp |
| Other | app_state, canvas, cli, clipboard, codebase_index, compose_prompt, feedback, fileindex, log, mention_search, mission_control, pdf_annotations, plans, project_session, recent_files, search, skills, telemetry, updater, window |

Adding a command is a three-edit rule:

1. **Write the fn.** `#[tauri::command]` in `commands/<domain>.rs`.
2. **Declare the module.** `pub mod <domain>;` in `commands/mod.rs` (new files only).
3. **Register the handler.** Add the fn to `tauri::generate_handler![]` in `lib.rs`.

Miss any of the three and the command either fails to compile or silently 404s from the frontend's `invoke()`.

**Every blocking operation must run inside `tokio::task::spawn_blocking`** — `Command::output`/`Command::spawn`, file I/O over large trees, git subprocess calls, anything not already `async`. The Tauri command runtime is shared with the UI's IPC channel; a blocking call there stalls every other in-flight command and freezes the UI.

### Event channels

Streaming from Rust to the UI runs on Tauri events, `atlas:*` channels, most payload-typed by a `kind` field rather than one channel per message shape.

| Channel | Carries |
|---|---|
| `atlas:agents` | every agent delta — message append, content-block delta, tool call, permission request, status, error, done |
| `atlas:threads-changed` | thread-metadata store changed; the sidebar's only refresh signal |
| `atlas:capture-changed` | Timeline / checkpoint record updated |
| `atlas:agent-elicitation`, `atlas:agent-elicitation-resolved` | agent-initiated prompts to the user |
| `atlas:agent-catalog:changed`, `atlas:registry-install:progress` / `:done` | Marketplace catalog and install lifecycle |
| `atlas:auth-run:progress` / `:done` | interactive agent sign-in run |
| `atlas:modelchat` | model-chat streaming |
| `atlas:browser-nav` | embedded-webview navigation state |
| `atlas:git-changed`, `atlas:git-status-fresh`, `atlas:git:op` | git state invalidation from the fs-watcher, and long-op progress |
| `atlas:codebase-index:progress` | codebase-index build progress |
| `atlas:update-checking` / `-available` / `-progress` / `-ready` / `-applied` / `-error` | auto-updater lifecycle |
| `atlas:auth-changed` / `-signed-out` / `-error` | account/session state |
| `atlas:byok-env-updated` | shell-profile API-key environment changed |
| `atlas:recent-files-changed`, `atlas:models-changed`, `atlas:models-pricing-updated` | cache-invalidation broadcasts |
| `atlas:cli-open-project`, `atlas:close-active-tab` | native menu / single-instance-relaunch plumbing |
| `atlas:explorer:changed`, `atlas:fileindex:updated` | file-tree and file-index invalidation |
| `atlas:knowledge:links-changed`, `atlas:knowledge:meta-changed` | knowledge-base backlink and metadata updates |
| `atlas:model-download:*`, `atlas:memory-embed:*` | local model download and embedding progress |

## Agent runtime

Atlas's agent stack is a port of Zed's, taken as a mechanism rather than rewritten. Two kinds of agent run behind one seam: **Cersei**, the native in-process agent driving the Cersei SDK, and any number of **external ACP agents** — subprocesses speaking Agent Client Protocol (JSON-RPC over stdio). Nothing above the seam knows which it is talking to.

**A fresh install has no ACP agents at all.** Only Cersei is offered. An external agent exists exactly when the user installed it from the Marketplace, which writes the single entry in the installed-agents map; nothing else makes an agent runnable. Finding a binary on `PATH` is a *detection* — an offer the user can accept, never a spawn candidate. See [ADR-0002](docs/adr/0002-no-default-acp-agents.md).

### The seam: `AgentConnection`

`AgentConnection` (`crates/atlas-acp-thread/src/connection.rs`) is the trait every agent implements — one live connection, with turns driven through `prompt`.

| Implementation | Crate | Drives |
|---|---|---|
| external ACP agent | `atlas-agent-servers` | a subprocess over JSON-RPC/stdio |
| Cersei | `atlas-native-agent` | the native agent, in-process |

Beyond `prompt` / `cancel` / `authenticate`, **every optional behaviour is capability-gated** — either a `supports_*` predicate (`supports_load_session`, `supports_resume_session`, `supports_close_session`, `supports_logout`) or an `Option<Arc<dyn …>>` sub-trait the connection returns only when the agent advertised it (`model_selector`, `session_modes`, `session_config_options`, `session_list`, `truncate`, `retry`, `set_title`, `telemetry`). A caller asks the connection what it can do; it never asks who it is.

**Branching on agent identity is forbidden.** Capabilities come from what the agent advertised at `initialize`. An `if agent_id == "claude"` is a bug, not a shortcut — it is what made the pre-port stack impossible to extend to an agent nobody had hand-written support for.

### Manager, host, and the delta projection

Three layers sit between the connection and the IPC surface:

- **`AgentManager`** (`crates/atlas-agent-manager`) owns who is connected and which sessions are open on them — ported from Zed's `AgentConnectionStore`. Three behaviours worth knowing: a second connect request while the first is still connecting *joins* it rather than starting a second process; a failed connection does not stick (the entry records the error for waiters, then goes, so the next request retries instead of replaying the failure forever); and a version bump drops the connection, because the running process is on the old binary.
- **`AgentHost`** (`src-tauri/src/commands/agent_host.rs`) is what `commands/agents.rs` talks to. It holds the three things the ported stack deliberately does not do: the **identity map** between the frontend's per-spawn `AgentId`/`SessionKey` and the manager's own keys, the **history** row kept current in the thread-metadata store, and cheap **session metadata** (`snapshot_meta`) on the send path.
- **`DeltaProjector`** (`crates/atlas-agent-delta`) turns thread events into the wire the rest of Atlas consumes.

### The frozen wire

Every delta travels an ordered `OutboundPipeline` (`atlas-bus`) of independent middleware: `BroadcastMiddleware` (the `atlas:agents` window event), `CaptureMiddleware` (Timeline + the permanent checkpoint record), `AnalyticsMiddleware`, `TranscriptMiddleware`, `MemoryIngestMiddleware`.

The `SessionDelta` shapes those consumers pattern-match live in **`crates/atlas-agent-wire`** and are **frozen**. `crates/atlas-agent-wire/tests/contract.rs` is the enforcement: it spells the contract out itself and fails if the enum drifts from it. (It also cross-checks `docs/agents/delta-wire-contract.md` when that file is present — the prose contract is a working note and is git-ignored, which is exactly why the test does not rely on it.) The thread model and the wire disagree about what a "message" is — the thread keeps one entry per assistant message with interleaved text and thought chunks; the wire emits one message per contiguous run of a kind — and reconciling that gap is precisely `atlas-agent-delta`'s job.

### `commands/agents.rs`

37 IPC verbs. The session lifecycle (`agents_spawn`, `agents_new_session`, `agents_send`, `agents_cancel`, `agents_kill`), the capability-gated knobs (`agents_set_mode`, `agents_set_model`, `agents_set_effort`, `agents_set_config_option`), permissions and elicitation (`agents_respond_permission`, `agents_respond_elicitation`), auth (`agents_authenticate`, `agents_list_auth_methods`, `agents_run_auth_method`, `agents_logout`), and the history surface (`threads_history`, `threads_resume`, `threads_archive`, `threads_delete`, `threads_projects`, `threads_import`, `threads_import_candidates`).

Deltas return over the single `atlas:agents` channel, payload-typed by `kind`.

### Three invariants

- **Atlas owns its history.** The sidebar reads the app-owned thread-metadata store (`crates/atlas-thread-metadata`, `threads.db`) and nothing else. Atlas does not read any agent CLI's private storage to build history — the per-agent scrape readers were deleted and must not come back. See [ADR-0001](docs/adr/0001-app-owned-thread-metadata-store.md), and `CONTEXT.md` for the thread/session/draft/archive vocabulary.
- **A thread is not a session.** A *thread* is the conversation Atlas tracks, keyed by an id Atlas mints; it exists before any agent process and outlives one forgetting the session. A *session* is the agent-side conversation, keyed by an ACP session id. A thread references at most one session. Collapsing the two is the mistake the old `acpSessionId`-as-filename design made.
- **Streams are tab-independent.** The projector owns the broadcast, not any UI component — concurrent prompts in several tabs keep streaming regardless of focus. Switching tabs resubscribes; no in-flight state is created, paused, or lost.

**PATH resolution.** macOS strips `PATH` from GUI-launched processes, so a bundled `.app` cannot see a user-installed agent CLI that a terminal in the same account finds fine. `crates/atlas-agent-servers/src/host_env.rs` resolves the real one: a fast guessed pass, then the user's actual login-shell `PATH` via `$SHELL -lc 'echo $PATH'` under a short timeout, because no static guess covers every version manager.

## Crates (`crates/`)

All wired in as `path` dependencies from `src-tauri/Cargo.toml`, and all members of the **root `[workspace]`** bar one (`atlas-kb-server`, below). The repo went without one for a long time, for a real reason: the ported stack pins `agent-client-protocol` 2.0 with its schema crate pinned exactly, and no single Cargo resolution could hold that alongside the old stack's exact `=1.4.0` pin. That collision is why the port had to land as one change rather than gradually. With the old stack gone the collision is gone, and the workspace landed (issue #38) so the vendored Codex engine resolves against the same graph as the app. Consequences worth knowing: one `Cargo.lock` and one `target/` at the repo root, and `[patch.crates-io]` plus every `[profile.*]` live in the root `Cargo.toml` — cargo honors both only there. `crates/atlas-kb-server` is deliberately excluded (it is built on demand at runtime under its own profile).

### The ported ACP stack

| Crate | Role |
|---|---|
| `atlas-acp-thread` | Port of Zed's `acp_thread`: the agent session model and the `AgentConnection` seam every agent plugs into. Chunk merging by `messageId`, permission prompts surviving concurrent status changes. |
| `atlas-agent-servers` | Port of Zed's `agent_servers`: transport to an external ACP agent and the launcher that starts one. Where the port's reliability lives — connect, initialize, cancel, retry — plus `host_env.rs`'s PATH resolution. |
| `atlas-agent-store` | Port of Zed's agent store: where an external agent comes from and how its command line is resolved. Backs the Marketplace and the installed-agents map. |
| `atlas-agent-manager` | Who is connected, and which sessions are open on them. Ported from Zed's `AgentConnectionStore`, with the session ownership Zed spreads across its per-agent view folded in. |
| `atlas-agent-delta` | Projects ported-thread events into the frozen `SessionDelta` wire. Reconciles the thread's one-entry-per-message model with the wire's one-message-per-contiguous-run model. |
| `atlas-agent-wire` | The frozen session-delta wire shapes, enforced by `tests/contract.rs`. |
| `atlas-native-agent` | Cersei on the `AgentConnection` seam — the native agent as just another connection. |
| `atlas-agent-transcript` | Where an agent keeps its record of a conversation, and how to read Atlas's own text back out of one. The Claude JSONL replay it used to hold is gone. |
| `atlas-thread-metadata` | The app-owned thread-metadata store (`threads.db`) — Atlas's only source for the sidebar and history. Metadata only, never transcript content. Ported from Zed's `ThreadMetadataStore`. See ADR-0001. |
| `atlas-bus` | Event broadcaster + middleware pipeline seam: a `tokio::sync::broadcast`-backed fan-out (lagging subscribers drop rather than block the producer), plus `OutboundPipeline`/`InboundPipeline`. Generic — no dependency on any agent or ACP type. |

### Everything else

| Crate | Role |
|---|---|
| `atlas-checkpoint` | The agent-session record: local SQLite store (`.atlas/sessions.db`), redact-on-write capture, git commit linkage, transcript import, sync outbox. Tauri-free, so the whole surface is testable against a real database and a real git repo. |
| `atlas-redact` | Single source of truth for secret redaction: layered scrubbing (Shannon entropy, vendored betterleaks rules, provider prefixes, credentialed URIs, connection strings) with JSON-aware traversal. String in, redacted string out — no I/O, no async. |
| `atlas-git` | Git execution layer: one spawn chokepoint over the real `git` binary (so hooks run), a typed stderr→error taxonomy with friendly messages (ported from GitHub Desktop/dugite), porcelain-v2 status parsing, streaming output for long operations. |
| `atlas-gitdiff` | Structured side-by-side diff engine: parses unified diffs, computes word-level intra-line change spans (word-diff vendored from `dandavison/delta`, MIT). |
| `atlas-terminal` | Wraps `portable-pty`, manages `TerminalSession`s, bridges PTY bytes to Tauri events. |
| `atlas-memory` | On-device RAG/memory engine: MiniLM → usearch HNSW plus grafeo graph memory, behind a `MemorySearchFn` seam. Read its `README.md` and `MIGRATION.md` before changing on-disk index formats. |
| `atlas-embed` | On-device text embeddings (BERT-family sentence-transformers) and a small vector store, isolated so `candle`'s heavy dependency tree doesn't slow everything else's incremental builds. Embedding only — on-device generation was removed 2026-08-22. |
| `atlas-codeindex` | Deterministic codebase scanner: turns live source into structural, embeddable docs via its own tree-sitter code intelligence (Rust/TS/TSX/JS/Python/Go). |
| `atlas-kb-server` | Standalone static-server binary produced by the knowledge base's "Export server" action. Embeds the exported HTML/CSS via `include_dir!`, serves on `localhost:4747`. |

## Persistence

Most app state is plain files, by design — but **two subsystems are SQLite**, and both are Atlas's own databases rather than anyone else's:

| Store | Path | Crate |
|---|---|---|
| Session history (thread metadata) | `<app-config-dir>/threads.db` | `atlas-thread-metadata` |
| Session record / Timeline (checkpoints) | `<project-root>/.atlas/sessions.db` + blob sidecar | `atlas-checkpoint` |

`<app-config-dir>` is Tauri's `app_config_dir()` — `~/Library/Application Support/dev.atlas.ide/` on macOS. History is global because threads are grouped *across* projects; the checkpoint record is per-project because a Timeline is about one worktree.

**Atlas does not read another program's storage to build session history.** The per-agent scrape readers are deleted (ADR-0001). Two deliberate reads of CLI directories remain and are not history: the checkpoint importer, under its own preserved contract, and the memory/skills surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills) as documents. `CONTEXT.md` records one flagged exception — the Memory panel's Codex thread list.

Everything else is per-project files under `<project-root>/.atlas/`:

```
<project-root>/.atlas/
├── sessions.db               checkpoint/Timeline record (SQLite) + blobs/
├── knowledge/                markdown notes, in subdirectories
├── shared-memory/            cross-agent memory facts
├── memory/                   on-device RAG index (atlas-memory)
├── codebase-index/           atlas-codeindex output
├── repos/                    repos cloned via the GitHub panel
├── skills/, agent-skills/    SKILL.md files
├── packs/                    installed packs
├── plans/                    plan documents
├── screenshots/, canvas-media/
├── logs.jsonl                per-project activity log
├── interactions.jsonl        knowledge-base interaction history
├── canvas.json               ReactFlow node/edge state (Canvas / Spaces)
├── editor-state.json         open tabs + split-column layout
├── project.json              per-project settings
├── recent-files.json         recent-file list
└── git-status-cache.json     cached git status
```

```
~/.atlas/
└── log/pinned.jsonl          pinned activity-log rows (survive restart)
```

**IPC** is Tauri's `invoke()` for request/response, `listen()` for event streams. All payloads are JSON.

## Project structure

```
atlas/
├── src/                          React 19 frontend
│   ├── App.tsx, main.tsx         entry points
│   ├── features/                 one folder per feature (~30 slices)
│   ├── components/                cross-feature widgets
│   ├── ui/                        primitives (Kbd, etc.)
│   ├── hooks/                     shared React hooks
│   ├── lib/                       utilities (cn, createSelectors, constants)
│   ├── styles/                    Tailwind 4 + design tokens
│   └── types/                     shared TS types (agent.ts, acp.ts, etc.)
│
├── src-tauri/                    Tauri host (Rust)
│   ├── src/
│   │   ├── main.rs                binary entry
│   │   ├── lib.rs                 tauri::Builder + invoke_handler + patch guards
│   │   ├── auth/                  account/session auth
│   │   ├── state/                 shared AppState
│   │   ├── telemetry/             PostHog client (opt-out, on by default)
│   │   ├── logging.rs, menu.rs
│   │   └── commands/               one .rs per IPC domain (69 modules)
│   ├── capabilities/              Tauri v2 permission manifests
│   ├── icons/                     bundle icons
│   ├── bin/, resources/           bundled helper scripts (atlas-cli.sh, nvm.sh)
│   ├── build.rs                   build script
│   ├── tauri.conf.json            bundle config, CSP, window
│   └── Cargo.toml                 path deps (patches + profiles live at the root)
│
├── crates/                        Rust crates (workspace members)
│   ├── atlas-acp-thread           session model + the AgentConnection seam
│   ├── atlas-agent-servers        external ACP transport + launcher + host env
│   ├── atlas-agent-store          where an agent comes from (Marketplace)
│   ├── atlas-agent-manager        connections and their open sessions
│   ├── atlas-agent-delta          thread events → frozen SessionDelta wire
│   ├── atlas-agent-wire           the frozen wire shapes (contract-tested)
│   ├── atlas-agent-transcript     an agent's own record of a conversation
│   ├── atlas-native-agent         the vendored engine on the AgentConnection seam
│   ├── atlas-thread-metadata      app-owned session history (threads.db)
│   ├── atlas-bus                  event bus + middleware pipeline
│   ├── atlas-checkpoint           session record / Timeline (sessions.db)
│   ├── atlas-redact               secret redaction (single source of truth)
│   ├── atlas-git                  git spawn chokepoint + error taxonomy
│   ├── atlas-gitdiff              structured diff engine
│   ├── atlas-terminal             PTY (portable-pty)
│   ├── atlas-memory               on-device RAG/memory engine
│   ├── atlas-embed                on-device embeddings (candle)
│   ├── atlas-codeindex            tree-sitter codebase scanner
│   └── atlas-kb-server            self-contained KB static-server binary
│
├── vendor/                        vendored source, workspace members
│   └── codex                        the engine behind Atlas Agent (ADR-0004)
│
├── scripts/                       build/release helpers (with-posthog-env.mjs)
├── landing/                       marketing site source
│
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── postcss.config.js
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── TELEMETRY.md
└── ARCHITECTURE.md                (this file)
```

## Gotchas

- **The Cersei patch table is gone (#54).** The `cersei-provider`/`cersei-agent` `[patch.crates-io]` overrides and their compile guards were deleted with the Cersei path itself. The two failure classes they fixed are still guarded, by tests against the engine that replaced them rather than by a patch table: a chunk-split fixture that splits an SSE frame at every byte position, and a cancel test that asserts on the filesystem — the killed command's marker file never appears. See the root `Cargo.toml`'s `[patch.crates-io]` comment.
- **`vite.config.ts`'s `dedupe` is load-bearing.** Lazy-loaded language packages (`lang-json`, `lang-rust`, …) each transitively import `@codemirror/{state,view,language}` and `@lezer/*`; without `dedupe`, Rollup can ship two copies in the production bundle. `EditorView.theme(...)` then registers against one copy's `StyleModule` while the `EditorView` construction uses the other, and the theme silently no-ops — text renders unstyled. Same story for `pdfjs-dist`: two copies mismatch the worker against the main-thread API version and PDF rendering fails. Dev mode does not reproduce either failure (Vite serves a single pre-bundled instance) — this only shows up in production builds.
- **Release-profile `panic = "unwind"` is required.** The local-LLM loader (`atlas-embed`, used by memory chat) `catch_unwind`s candle's Metal kernel-compile panic to fall back to CPU. `panic = "abort"` would crash the app outright instead of degrading gracefully; the cost is a small amount of extra binary size for unwind tables.
- **The single-instance plugin is release-only.** Registered behind `#[cfg(not(debug_assertions))]` in `src-tauri/src/lib.rs`. Registering it in debug builds kills `tauri dev` the instant it starts whenever the installed `/Applications/Atlas.app` is already running — the dev process gets treated as the "second instance," forwards its argv, and exits.
- **Telemetry is opt-out and on by default** (`share_telemetry: true` in `state/app_state.rs`), despite `src-tauri/src/telemetry/mod.rs`'s module doc claiming zero analytics until explicit opt-in via a first-run consent prompt that doesn't exist in the code. `app_state.rs` reflects actual behavior; the doc comment is stale. Metadata is coarse and inert without a PostHog key. The auto-updater's remote-config check runs independently of the telemetry opt-in — gated only by the separate `auto_update` setting.
