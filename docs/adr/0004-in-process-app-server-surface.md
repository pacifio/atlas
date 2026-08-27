# ADR-0004: The ported engine is driven in-process at the app-server layer

**Status:** Accepted (2026-08-28)

## Context

ADR-0003 decided *what* the native agent's engine becomes — a one-time port of Codex — and deliberately left *how the app talks to it* to the integration research. That question is now due: Phase 2 rewires the `atlas-native-agent` seam's impl bodies onto the ported engine, and every later ticket is written against whichever answer lands here.

Three surfaces were available, and they are not equally supported upstream:

1. **Raw `ThreadManager` / core-api.** Linking `codex-core` and driving the engine handle directly. This looks like the obvious "it's a library" choice, and it is the one no shipped OpenAI binary takes. The only raw consumer in the fork is `thread-manager-sample`, explicitly fenced as a sample.
2. **A spawned app-server binary over stdio.** Atlas builds and ships the engine as a child process and speaks JSON-RPC to it. Real fault isolation, at the price of a process boundary.
3. **The in-process app-server client.** `codex-app-server-client` runs the app-server's own `MessageProcessor` on Tokio tasks in the host process, replacing socket/stdio transports with bounded in-memory channels. Requests go in as typed Rust values. This is what OpenAI's TUI and `codex exec` — the flagship frontends — actually ship: neither links `codex-core` at all.

The decision hinges on a fact the "library vs protocol" framing hides: **the supported embedding contract *is* the app-server protocol**, and in-process is the supported way to consume it from Rust without a process boundary. Choosing (1) would put Atlas's daily code path somewhere upstream battle-tested nothing.

Spec open question 3 asked whether (3) drags in ambient process startup Atlas would have to neutralize — the stdio server's `run_main_with_transport_options` does OTel provider construction, a unix-socket startup lock, and SQLite state-db init. That was the one thing that could have disqualified it. **It was traced before this ADR was accepted; the answer is that the in-process entry performs none of the three** (findings recorded in the spec's open question 3).

## Decision

**Drive the ported engine in-process, through `codex-app-server-client`'s `InProcessAppServerClient`, from inside the `atlas-native-agent` seam.** `src-tauri` keeps calling only the `AgentServer` / `AgentConnection` trait surface and never sees an engine type.

- **The engine's config is assembled in the seam**, not in `src-tauri` and not in the engine: the provider, the D10 token provider, analytics off, sandbox and approval defaults, and the `codex_self_exe` path. The seam is the only place that knows both Atlas's settings and the engine's shape.
- **`codex_home` is an Atlas-owned directory**, never `~/.codex`. This is not cosmetic: starting the runtime calls `resolve_installation_id`, which `create_dir_all`s that path and creates a `0644` installation-id file. Under D9 that whole tree is engine-private working storage — the sidebar and history keep reading only the app-owned thread-metadata store (ADR-0001).
- **The transport escape hatch is kept explicitly.** `AppServerClient` is an enum — `InProcess` and `Remote` — over one protocol. If fault isolation ever forces the engine out of the GUI process, that is a transport swap plus supervision, not a rewrite. This is a reason to prefer the client facade over raw core *now*, while nothing forces the move.
- **Raw core-api remains the documented fallback**, unused, for the case where the app-server layer proves too heavy to own.

## Consequences

- **An engine panic kills the GUI.** This is the strongest argument against, and it is accepted rather than answered: in-process, any panic, abort, deadlock, or memory-safety bug anywhere in ~600k LOC of newly-owned code — including the 307-`unsafe` Windows sandbox crate and the 91-`unsafe` pty layer — takes the whole app, the user's unsaved state, and every other agent session with it. A spawned server's worst case is a dead child the UI can report and resume past. Atlas is betting the engine is stable enough to live in the GUI process; the bet is revisited on real crash telemetry, and the escape hatch above is what makes losing it cheap.
- **Atlas rides the contract upstream tests.** The interrupt path (reply deferred until `TurnAborted`), approval routing, and thread listing/resume are the same code the TUI exercises daily — inherited rather than re-derived.
- **The seam owns a translation layer, permanently.** Engine events must be mapped onto the ACP session-update vocabulary the app already speaks. That mapping is the seam's real work and its main maintenance cost.
- **The protocol envelope is not free.** In-process is transport-local but *not* protocol-free: typed requests still return through the JSON-RPC result envelope. Upstream calls this intentional — it keeps in-process behavior aligned with app-server rather than creating a second execution contract — and Atlas inherits both the alignment and the envelope.
- **One injection point had to be added to the fork.** The engine's `ExternalAuth` trait is the D10 seam, but neither `InProcessStartArgs` nor `InProcessClientStartArgs` exposes it, and the only in-protocol route to `AuthManager::set_external_auth` is ChatGPT-shaped (`LoginAccountResponse::ChatgptAuthTokens`, gated on `ForcedLoginMethod::Chatgpt`, refreshing by a server→client `ChatgptAuthTokensRefresh` round-trip) — a path D2 rips out. Rather than abuse it or reach around the facade, the fork gains an `external_auth` field on both start-args structs, installed against the `AuthManager` the runtime already builds. This is exactly the kind of change owning the fork is *for*, and it carries the §4(b) change notice.
- **This decision is reversed if** engine panics in shipped builds are killing the app often enough to hurt users more than the protocol hop would. That is the concrete, measurable reversal test; the escape hatch exists so acting on it is a transport change.
