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
│  │  • Zustand stores           │    │  • commands/ — ~326 IPC verbs   │ │
│  │  • CodeMirror, xterm,       │    │    across 67 domain modules     │ │
│  │    Tiptap, Pixi, TanStack   │    │  • atlas-acp (ACP/JSON-RPC)     │ │
│  │  • Tailwind v4              │    │  • atlas-agents (session actor) │ │
│  │                             │    │  • atlas-cersei (native agent)  │ │
│  │                             │    │  • atlas-terminal (PTY)         │ │
│  │                             │    │  • atlas-memory / atlas-embed   │ │
│  │                             │    │  • spawn_blocking for all I/O   │ │
│  └─────────────────────────────┘    └───────────────────────────────┘ │
│                                                                        │
│  Persistence:                                                          │
│  • Per-project: <project>/.atlas/ (knowledge, canvas.json,             │
│    editor-state.json, logs.jsonl, memory index, codebase-index,        │
│    cloned repos, skills, packs, papers)                                │
│  • Global:      ~/.atlas/ (pinned log rows)                            │
│  • Claude Code: ~/.claude/projects/<slug>/*.jsonl (read directly,      │
│    never mirrored)                                                     │
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

`src/features/` holds ~30 slices: chat, editor, terminal, browser, git, github, explorer, knowledge, canvas, layout, log, monitor, research, settings, memory, mission-control, model-chat, organisations, packs, skills, telemetry, updater, workspaces, and more.

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
| Chat | queues, draft text, scroll position (`chat/stores/chat-store.ts`) | `atlas-agents`' per-session actor — message log, tool calls, run status, streamed over `atlas:agents` |
| Editor | open-file metadata, dirty flags (`editor/stores/editor-store.ts`) | CodeMirror owns the document text |
| Terminal | split/pane layout (`terminal/stores/terminal-store.ts`) | `atlas-terminal`'s PTY session owns the byte buffer |

This is a deliberate performance boundary, not an oversight to fix by moving more state into the store. Lifting chat messages, document text, or terminal bytes into Zustand degrades streaming, typing, and PTY throughput — every keystroke would touch Immer.

Other stores: `project/stores/project-store.ts` (current project, recents), `git/stores/git-store.ts` (branch, status, lane-assigned commit graph), `log/stores/log-store.ts` (ring-buffered event log, 500 in memory, + on-disk pinned rows), `knowledge/stores/knowledge-store.ts`, `canvas/stores/canvas-store.ts` (ReactFlow nodes/edges), `monitor/stores/usage-store.ts` (token usage per provider/model).

### Tabs and the split-column layout

`layout/stores/layout-store.ts` owns the tab system:

- `addTab` / `closeTab`, per-tab-type dedupe rules.
- **Up to 3 columns** (`groupOrder`, capped at 3). Each tab carries a `groupId` naming its column.
- A maintained `activeTabId` mirrors the focused column's active tab, so most readers don't need to know splits exist.

`src/lib/constants.ts` holds `TAB_TYPES` (the tab-type registry); `CenterPanel.tsx` holds the lazy-import map keyed off it. New panel type = lazy import in `CenterPanel.tsx` + entry in `TAB_TYPES` + entry in `NEW_TAB_OPTIONS` if it should reach the `+` menu.

**Persistent module types — editor, terminal, browser, knowledge-graph, pdf — stay mounted across tab switches** via `display: contents` / `display: none` instead of unmounting. Remounting would rebuild CodeMirror instances, kill the PTY's rendered scrollback, or tear down the native embedded webview.

## Backend (`src-tauri/src/`)

One Rust module per IPC domain under `src-tauri/src/commands/`. `commands/mod.rs` declares 67 `pub mod` domain files:

| Domain group | Modules |
|---|---|
| Agents & Claude | agents, claude, claude_setup |
| Terminal / browser / fs | terminal, browser, fs |
| Git | git, git_graph, git_watcher, gitdiff |
| GitHub | github |
| Knowledge | knowledge, knowledge_meta, knowledge_links, knowledge_export |
| Canvas / misc | canvas, pomodoro, log |
| Memory | memory_* — chat, sessions, graph, pack, policy, sharing, summarize, timeline, delta, inject, compile, indexer, retrieve |
| Models | models, models_pricing |
| Model chat | modelchat, modelchat_sessions |
| Shared memory | agent_memory, shared_memory |
| Analytics & feedback | agent_analytics, tool_stats, feedback |
| Other | mission_control, papers, pdf_annotations, plans, research, review, search, sessions_watch, skills, telemetry, updater, window, byok, auth, node_setup, mcp, cersei, codebase_index, clipboard, fileindex, mention_search, recent_files, app_state, cli, compose_prompt, git_ops, knowledge_graph_layout |

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
| `atlas:memory-chat`, `atlas:modelchat` | memory/RAG chat and model-chat streaming |
| `atlas:review` | code-review streaming |
| `atlas:browser-nav` | embedded-webview navigation state |
| `atlas:git-changed`, `atlas:git-status-fresh` | git state invalidation from the fs-watcher |
| `atlas:codebase-index:progress` | codebase-index build progress |
| `atlas:update-checking` / `-available` / `-progress` / `-ready` / `-applied` / `-error` | auto-updater lifecycle |
| `atlas:auth-changed` / `-signed-out` / `-error` | account/session state |
| `atlas:sessions-changed`, `atlas:recent-files-changed`, `atlas:models-changed`, `atlas:models-pricing-updated` | cache-invalidation broadcasts |
| `atlas:cli-open-project`, `atlas:close-active-tab` | native menu / single-instance-relaunch plumbing |
| `atlas:explorer:changed`, `atlas:fileindex:updated` | file-tree and file-index invalidation |
| `atlas:knowledge:links-changed`, `atlas:knowledge:meta-changed` | knowledge-base backlink and metadata updates |
| `atlas:claude-install:*`, `atlas:node-install:*` | `claude` CLI and Node bootstrap progress |
| `atlas:model-download:*`, `atlas:memory-chat-model:*`, `atlas:memory-embed:*` | local model download and embedding progress |

## Agent runtime

Atlas ships three selectable agents. **Claude Code** and **Codex** run as external subprocesses speaking ACP (Agent Client Protocol, JSON-RPC over stdio). **Atlas** is the native, in-process agent, driving the Cersei agent SDK directly, and translates Cersei's event stream into the same `AcpEvent` shapes the subprocess agents produce — the session actor, the delta wire format, and the UI stay identical regardless of which agent is running.

The ACP registry (`crates/atlas-acp/src/registry.rs`) also carries scaffolding for an OpenCode ACP bridge (`AgentSpec::opencode`) and two Claude Code launch variants (`claude_code_ts` — the canonical `@agentclientprotocol/claude-agent-acp` — and `claude_code_rs`). Claude Code, Codex, and the native Atlas agent are the three meant to be user-selectable today.

### The seam: `AgentBackend`

`AgentBackend` (`crates/atlas-agents/src/backend.rs`) is the trait that makes the two transports interchangeable above this line:

```
new_session, load_session, send_prompt,
set_session_mode, set_session_model,
cancel_turn, respond_permission,
register_session, drop_session,
authenticate, kill
```

| Implementation | Wraps | Drives |
|---|---|---|
| `AcpBackend` | `atlas_acp::AgentRegistry` | Claude Code / Codex subprocesses over JSON-RPC |
| `CerseiBackend` | `atlas_cersei::CerseiRuntime` | the native agent, in-process |

`AgentManager::spawn` (`crates/atlas-agents/src/manager.rs`) picks the backend at spawn time: the Cersei plugin gets a `CerseiBackend`, anything else gets an `AcpBackend`. Everything downstream — the actor, event dispatch, `SessionState`, the frontend — talks to `Arc<dyn AgentBackend>` and never branches on transport.

### The per-session actor

Each session runs on one single-owner tokio task, `SessionActor` (`crates/atlas-agents/src/actor.rs`), spawned by the manager and handed back as an `ActorHandle` (a control sender + a stream sender) — not a shared worker pool. Its `tokio::select!` loop multiplexes two inputs into one FIFO:

- **`control_rx`** — user intents: `Send`, `Cancel`, `RespondPermission`, `SetMode`, `SetModel`, `SetEffort`, `SetCompress`.
- **`stream_rx`** — an ordered `ActorMsg` stream: inbound `Acp` events routed from the manager's event sink, plus the turn's own lifecycle signals (`TurnDone`, `FinalizeTimeout`, `CancelDeadline`, `Disconnect`, `SettingResult`).

Agent events and turn-completion share the same FIFO, so ordering is structural rather than polled or inferred. One caveat: `TurnDone` can resolve before a turn's tool calls have all reported terminal, so finalization also gates on tool-call quiescence, backstopped by a bounded `FinalizeTimeout`. A monotonic `TurnId` plus an `is_same_turn` check makes preemption (cancel-then-send) safe — a superseded turn's late events drop instead of corrupting a fresh turn's state.

One owner of session mutation state closes the races that used to require careful locking under an older shared-worker design. `AgentManager` (`crates/atlas-agents/src/manager.rs`) is the registry above the actors — installed plugins, running sessions, which session belongs to which UI tab — not a place where message state lives.

### `commands/agents.rs`

| IPC verb | |
|---|---|
| `agents_list_plugins`, `agents_new_session`, `agents_load_session`, `agents_send`, `agents_cancel`, `agents_set_mode`, `agents_set_model`, `agents_respond_permission` | plus related session-lifecycle calls |

Deltas return over the single `atlas:agents` channel, payload-typed by `kind`: `message_appended`, `content_block_delta`, `tool_call`, `permission_request`, `status`, `error`, `done`.

### Two invariants

- **`acpSessionId` is the single source of truth.** It's both the wire session id and the filename stem under `~/.claude/projects/<slug>/<acpSessionId>.jsonl` — never split, derived, or rewritten elsewhere. UI tabs, history rows, and the on-disk transcript all key off the exact same string. Code that reconstructs or transforms this id is a bug.
- **Streams are tab-independent.** The actor, not any UI component, owns the message log and broadcasts deltas — three concurrent prompts in three tabs (or the history sidebar) keep streaming regardless of focus. Switching tabs just resubscribes to that session's actor broadcast; no in-flight state is created, paused, or lost.

**History.** The history sidebar reads Claude Code session JSONL files directly from `~/.claude/projects/<slug>/` — Atlas never mirrors them into its own store. Resuming a past conversation is a `loadSession` ACP call against the same session id.

**PATH resolution.** In production builds, `claude_setup.rs` resolves `claude` (and the Codex/OpenCode CLIs) via a login-shell lookup, because macOS strips `PATH` from GUI-launched processes. Without this the bundled `.app` can't find any user-installed agent CLI even though a terminal in the same account can.

## Workspace crates (`crates/`)

All wired in as `path` dependencies from `src-tauri/Cargo.toml`.

| Crate | Role |
|---|---|
| `atlas-acp` | ACP client transport. Speaks JSON-RPC to any ACP-speaking agent binary (Claude Code, Codex, OpenCode); forwards permission prompts, tool calls, content blocks. Tauri-independent — exposes an `EventSink` trait the host implements to fan events out as window events. |
| `atlas-agentkit` | Protocol-agnostic core that makes native and ACP-subprocess agents look identical: `AgentConnection` (one live agent connection, turns driven through `prompt`, optional capabilities as `Option<Arc<dyn …>>` sub-traits) and `TurnId`/`RunningTurn` (the monotonic turn identity the actor uses to drop superseded work). |
| `atlas-agents` | Multi-agent orchestration above `atlas-acp`: the plugin registry, `AgentManager`, the per-session `SessionActor`, `SessionState`/`SessionSnapshot`, the `SessionDelta` wire shape, JSONL transcript replay for `load_session`. |
| `atlas-bus` | Global event broadcaster + middleware pipeline: a cloneable `tokio::sync::broadcast`-backed `EventBus` fan-out (lagging subscribers drop rather than block the producer), plus `OutboundPipeline`/`InboundPipeline` middleware chains. |
| `atlas-cersei` | Atlas's native, in-process coding agent, built on the Cersei agent SDK. Read `crates/atlas-cersei/ARCHITECTURE.md` before touching agent lifecycle, tools, permissions, providers, or persistence. |
| `atlas-terminal` | Wraps `portable-pty`, manages `TerminalSession`s, bridges PTY bytes to Tauri events. |
| `atlas-memory` | On-device RAG/memory engine: MiniLM → usearch HNSW plus grafeo graph memory, behind a `MemorySearchFn` seam. Read its `README.md` and `MIGRATION.md` before changing on-disk index formats. |
| `atlas-embed` | On-device text embeddings and a small vector store, isolated so `candle`'s heavy dependency tree doesn't slow incremental builds of everything else. Also hosts a quantized Qwen2.5-Instruct decoder for local RAG answers. |
| `atlas-codeindex` | Deterministic codebase scanner: turns live source into structural, embeddable docs via its own tree-sitter code intelligence (Rust/TS/TSX/JS/Python/Go). |
| `atlas-gitdiff` | Structured side-by-side git diff engine: parses unified diffs, computes word-level intra-line change spans (word-diff algorithm vendored from `dandavison/delta`, MIT). |
| `atlas-kb-server` | Standalone static-server binary produced by the knowledge base's "Export server" action. Embeds the exported HTML/CSS via `include_dir!`, serves it on `localhost:4747`. |

## Persistence

No SQLite for app state — `rusqlite` is bundled only so the Codex-history reader can read Codex's own history DB in-process. State is plain files, by design.

| Location | Contents |
|---|---|
| `<project-root>/.atlas/knowledge/` | markdown notes, in subdirectories |
| `<project-root>/.atlas/logs.jsonl` | per-project activity log |
| `<project-root>/.atlas/canvas.json` | ReactFlow node/edge state (Canvas / Spaces) |
| `<project-root>/.atlas/editor-state.json` | open tabs + split-column layout |
| `<project-root>/.atlas/memory/` | on-device RAG index (`atlas-memory`) |
| `<project-root>/.atlas/codebase-index/` | `atlas-codeindex` output |
| `<project-root>/.atlas/repos/` | repos cloned via the GitHub panel |
| `~/.atlas/log/pinned.jsonl` | pinned activity-log rows, survive restart |
| `~/.claude/projects/<slug>/*.jsonl` | Claude Code history, read directly, never mirrored. Filename stem is the `acpSessionId`. |

Almost everything is per-project. `~/.atlas/` holds one file.

```
<project-root>/.atlas/
├── knowledge/                markdown notes, in subdirectories
├── shared-memory/            cross-agent memory facts
├── memory/                   on-device RAG index (atlas-memory)
├── codebase-index/           atlas-codeindex output
├── repos/                    repos cloned via the GitHub panel
├── skills/                   project-scoped SKILL.md files
├── packs/                    installed packs
├── papers/                   papers pulled in from Research
├── logs.jsonl                per-project activity log
├── interactions.jsonl        knowledge-base interaction history
├── canvas.json               ReactFlow node/edge state (Canvas / Spaces)
├── editor-state.json         open tabs + split-column layout
├── project.json              per-project settings
├── reviews.json              code-review results
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
│   │   └── commands/               one .rs per IPC domain (67 modules)
│   ├── capabilities/              Tauri v2 permission manifests
│   ├── icons/                     bundle icons
│   ├── bin/, resources/           bundled helper scripts (atlas-cli.sh, nvm.sh)
│   ├── build.rs                   build script
│   ├── tauri.conf.json            bundle config, CSP, window
│   └── Cargo.toml                 workspace deps + [patch.crates-io] + release profile
│
├── crates/                        Rust workspace crates
│   ├── atlas-acp                  ACP transport
│   ├── atlas-agentkit             protocol-agnostic agent core (AgentConnection, TurnId)
│   ├── atlas-agents                per-session actor + AgentManager
│   ├── atlas-bus                   event bus + middleware pipeline
│   ├── atlas-cersei                 native in-process agent (Cersei SDK)
│   ├── atlas-terminal               PTY (portable-pty)
│   ├── atlas-memory                 on-device RAG/memory engine
│   ├── atlas-embed                  on-device embeddings + local LLM (candle)
│   ├── atlas-codeindex               tree-sitter codebase scanner
│   ├── atlas-gitdiff                 structured diff engine
│   └── atlas-kb-server                self-contained KB static-server binary
│
├── vendor/                        [patch.crates-io] overrides
│   ├── cersei-provider              UTF-8 chunk-boundary fix
│   └── cersei-agent                 tool-cancel race fix
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

- **Vendored Cersei patches.** `cersei-provider` and `cersei-agent` are `[patch.crates-io]`'d in `src-tauri/Cargo.toml` to `vendor/cersei-provider` and `vendor/cersei-agent` instead of the crates.io release: the published `cersei-provider` corrupts multi-byte UTF-8 characters split across HTTP chunk boundaries, and the published `cersei-agent` never raced `tool.execute()` against the cancel token, leaving orphaned `tool_use` blocks in provider history on cancel. Compile-time guards (`_CERSEI_UTF8_PATCH_GUARD` in `src-tauri/src/lib.rs`, `_CERSEI_CANCEL_PATCH_GUARD` in `crates/atlas-cersei/src/lib.rs`) fail `cargo check` if either patch stops applying — that means the vendor override stopped resolving. Don't delete the guards to fix the build.
- **`vite.config.ts`'s `dedupe` is load-bearing.** Lazy-loaded language packages (`lang-json`, `lang-rust`, …) each transitively import `@codemirror/{state,view,language}` and `@lezer/*`; without `dedupe`, Rollup can ship two copies in the production bundle. `EditorView.theme(...)` then registers against one copy's `StyleModule` while the `EditorView` construction uses the other, and the theme silently no-ops — text renders unstyled. Same story for `pdfjs-dist`: two copies mismatch the worker against the main-thread API version and PDF rendering fails. Dev mode does not reproduce either failure (Vite serves a single pre-bundled instance) — this only shows up in production builds.
- **Release-profile `panic = "unwind"` is required.** The local-LLM loader (`atlas-embed`, used by memory chat) `catch_unwind`s candle's Metal kernel-compile panic to fall back to CPU. `panic = "abort"` would crash the app outright instead of degrading gracefully; the cost is a small amount of extra binary size for unwind tables.
- **The single-instance plugin is release-only.** Registered behind `#[cfg(not(debug_assertions))]` in `src-tauri/src/lib.rs`. Registering it in debug builds kills `tauri dev` the instant it starts whenever the installed `/Applications/Atlas.app` is already running — the dev process gets treated as the "second instance," forwards its argv, and exits.
- **Telemetry is opt-out and on by default** (`share_telemetry: true` in `state/app_state.rs`), despite `src-tauri/src/telemetry/mod.rs`'s module doc claiming zero analytics until explicit opt-in via a first-run consent prompt that doesn't exist in the code. `app_state.rs` reflects actual behavior; the doc comment is stale. Metadata is coarse and inert without a PostHog key. The auto-updater's remote-config check runs independently of the telemetry opt-in — gated only by the separate `auto_update` setting.
