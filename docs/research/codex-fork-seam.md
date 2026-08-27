# Codex fork seam: primary-source research for the one-time port (ADR-0003)

**Source tree:** `~/Codes/codex` at commit `42b5f05cef69491bc578901fb324b3c9a278b253` — exactly the fork point named in ADR-0003 (`42b5f05`, 2026-08-14). Working tree clean apart from an untracked `graphify-out/`. All `file:line` citations below are relative to `~/Codes/codex`.

**Method note:** the crate graph was derived from `cargo metadata` on `codex-rs/` (140 workspace packages resolve), not guessed. LOC counts are non-blank, non-`//`-comment Rust lines, with each crate's `tests/` directory excluded (inline `#[cfg(test)]` modules are still counted, so real shippable LOC is somewhat lower than the headline numbers).

## TL;DR — the seam in 10 bullets

1. **The spine is fat and unfeatured.** `codex-core`'s required transitive closure is **77 workspace crates, 1,684 Rust files, ~600k LOC** (~745k incl. `tests/` dirs). `codex-core` declares **zero cargo features** and 61 direct workspace deps, all non-optional — there is no feature-flag scalpel; any slimming is manual surgery.
2. **63 workspace crates are droppable outright**: tui, cli, exec, app-server family, cloud-tasks, mcp-server, ollama, lmstudio, chatgpt, backend-client, responses-api-proxy, core-api, most `ext/` extensions, and test-support crates.
3. **The wire format is not pluggable.** `WireApi` has exactly one variant, `Responses` (codex-rs/model-provider-info/src/lib.rs:61-65). The `ModelProvider` trait (codex-rs/model-provider/src/provider.rs:120) abstracts auth, capabilities, and model catalogs — not serialization or streaming.
4. **The engine's internal event and history types ARE the OpenAI Responses API.** `ResponseItem` (codex-rs/protocol/src/models.rs:846) and `ResponseEvent` (codex-rs/codex-api/src/common.rs:76) mirror Responses items/SSE 1:1 (encrypted reasoning, summary indices, `OpenAI-Model` header, safety routing), are consumed variant-by-variant in the turn loop (codex-rs/core/src/session/turn.rs:2260-2690), and are persisted to disk as session history (codex-rs/rollout/src/list.rs:1232).
5. **Ollama proves nothing about provider pluggability**: the crate is a health-check/model-pull helper (codex-rs/ollama/src/lib.rs:22-45) that requires Ollama ≥ 0.13.4 — the version that serves the *Responses API* (codex-rs/ollama/src/lib.rs:46-48). Every provider path in the repo, including Bedrock, speaks Responses.
6. **BYOK is close.** A provider with `requires_openai_auth: false` plus `env_key` or `experimental_bearer_token` skips the login screen entirely (codex-rs/model-provider-info/src/lib.rs:100-108, 136-138; api-key resolution at lib.rs:290-296). Atlas's settings-injected key is a config change, not an auth-stack rewrite — though the ~11.3k-LOC ChatGPT OAuth `login` crate stays compiled into the spine until surgically removed.
7. **Two phone-home paths ship inside the spine** and are rip-outs, not renames: OTLP metrics to `https://ab.chatgpt.com/otlp/v1/metrics` with a hardcoded Statsig client key (codex-rs/otel/src/config.rs:9-11), and per-session analytics to `{chatgpt_base_url}/codex/analytics-events/events` (default base `https://chatgpt.com/backend-api/`), created for **every session** and enabled unless config says `analytics_enabled = false` — and it sends a subset of events even under plain API-key auth (codex-rs/analytics/src/client.rs:684-691).
8. **License is a clean go.** Apache-2.0 (LICENSE; workspace `license = "Apache-2.0"` at codex-rs/Cargo.toml:147). Obligations: ship the license, carry the 3-line NOTICE, mark modified files, keep in-source attribution notices; §6 forbids using the "Codex"/"OpenAI" marks for branding — which the rebrand removes anyway. Full quotes in §4.
9. **Model identity leaks in through data, not just code**: the base system prompt says "Codex CLI … led by OpenAI" (codex-rs/models-manager/prompt.md:1, embedded at codex-rs/models-manager/src/model_info.rs:17), and per-model `instructions_template` strings live in the bundled `models.json` catalog (codex-rs/models-manager/models.json:704) — the same catalog shape the runtime fetches from the provider's `/models` endpoint.
10. **Security history:** exactly one published advisory (CVE-2025-59532 / GHSA-w5fx-fh39-j5rw, high, CVSS4 8.6 — sandbox path-boundary bypass, patched in 0.39.0, well before the fork point). After cutover Atlas must stand its own watch on `github.com/openai/codex/security/advisories`, as ADR-0003 already accepts.

---

## 1. Crate spine

### 1.1 The dependency spine from codex-core

`codex-core` (codex-rs/core) is the engine: session, turn loop, tool dispatch, sandbox orchestration. From `cargo metadata`:

- **Direct workspace deps of `codex-core`: 61** (codex-rs/core/Cargo.toml). None marked `optional = true`.
- **`codex-core` `[features]`: empty** (`cargo metadata` reports `features: {}` for the package; there is no `[features]` section in codex-rs/core/Cargo.toml).
- **Required transitive closure: 77 workspace crates.** Computing the closure with optional deps excluded vs. included yields the *same* set — nothing in the spine is behind a cargo feature.

The spine, grouped by role (all paths under `codex-rs/`; LOC excludes `tests/` dirs):

**Engine + protocol (the irreducible heart)**
| crate | path | LOC | role |
|---|---|---|---|
| codex-core | core | 174,623 | session/turn loop, tool dispatch, config assembly, compaction, delegate agents |
| codex-protocol | protocol | 20,354 | `ResponseItem`, events, IDs, auth/account types; TS + JsonSchema derives |
| codex-api | codex-api | 11,717 | Responses API request/SSE/websocket client layer |
| codex-client | codex-client | 165 | thin re-export: retry policy, SSE stream, telemetry hooks (codex-rs/codex-client/src/lib.rs:1-14) |
| codex-http-client | http-client | 6,983 | reqwest wrapper, proxy policy |
| codex-model-provider | model-provider | 3,268 | `ModelProvider` trait + OpenAI-compat & Bedrock impls |
| codex-model-provider-info | model-provider-info | 999 | serialized provider config (`ModelProviderInfo`, `WireApi`) |
| codex-models-manager | models-manager | 2,712 | model catalog (bundled `models.json` + remote `/models`), base instructions |
| codex-login | login | 11,346 | auth manager, ChatGPT OAuth/device-code, API-key auth, UA/originator |

**Persistence + state**
| crate | path | LOC | role |
|---|---|---|---|
| codex-rollout | rollout | 13,287 | JSONL session files ("rollouts"), listing, compression |
| codex-rollout-trace | rollout-trace | 11,364 | rollout tracing |
| codex-thread-store | thread-store | 25,565 | storage-neutral thread persistence interfaces (codex-rs/thread-store/src/lib.rs:1-5) |
| codex-state | state | 18,646 | SQLite mirror of rollout metadata (codex-rs/state/src/lib.rs:1-5) |
| codex-history | history | 1,095 | response-item envelopes |
| codex-config | config | 19,935 | config.toml layer stack, profiles |

**Execution + sandboxing**
| crate | path | LOC | role |
|---|---|---|---|
| codex-exec-server | exec-server | 27,031 | sandboxed command-execution environment/server |
| codex-exec-server-protocol | exec-server-protocol | 1,593 | its protocol |
| codex-sandboxing | sandboxing | 6,356 | seatbelt (macOS `.sbpl` policies), landlock, bwrap, windows shims |
| codex-windows-sandbox | windows-sandbox-rs | 17,363 | Windows sandbox (an **unconditional** dep of core — codex-rs/core/Cargo.toml:86, not target-gated; target-gated sections start at line 130) |
| codex-execpolicy | execpolicy | 1,728 | command policy engine |
| codex-shell-command | shell-command | 5,968 | shell parsing/canonicalization |
| codex-shell-escalation | shell-escalation | 1,904 | approval escalation |
| codex-apply-patch | apply-patch | 4,281 | apply_patch grammar + engine |
| codex-network-proxy | network-proxy | 15,709 | MITM-capable network proxy w/ cert machinery, connect policy |
| codex-utils-pty | utils/pty | 4,036 | PTY handling (91 `unsafe` occurrences) |

**Tools / MCP / extensions**
| crate | path | LOC | role |
|---|---|---|---|
| codex-tools | tools | 5,865 | tool registry/specs |
| codex-mcp | codex-mcp | 16,031 | MCP binding, elicitation, resource client |
| codex-rmcp-client | rmcp-client | 13,761 | MCP client (rmcp) |
| codex-core-plugins | core-plugins | 36,858 | plugin/marketplace loader, manifests, routing |
| codex-skills / codex-skills-extension | skills, ext/skills | 2,474 / 15,532 | skills loading + extension |
| codex-extension-api / codex-extension-items | ext/extension-api, ext/items | 1,272 / 280 | in-process extension seams |
| codex-plugin / codex-utils-plugins | plugin, utils/plugins | 777 / 298 | plugin runtime glue |
| codex-code-mode (+protocol) | code-mode, code-mode-protocol | 8,748 / 3,569 | "code mode" sessions (grpc/websocket/process) |
| codex-hooks | hooks | 11,660 | lifecycle hooks |
| codex-connectors | connectors | 4,444 | connectors support |
| codex-prompts | prompts | 1,556 | compact/review/permission prompt builders |

**Observability + misc (incl. the phone-home surface)**
| crate | path | LOC | role |
|---|---|---|---|
| codex-otel | otel | 4,080 | OTLP/Statsig exporters |
| codex-analytics | analytics | 12,534 | event capture + upload to ChatGPT backend |
| codex-feedback | feedback | 1,020 | feedback capture |
| codex-app-server-protocol (+noop-macros) | app-server-protocol | 27,957 / 9 | app-server wire types — pulled in because core emits `ServerNotification`s |
| codex-features | features | 2,206 | local feature flags (config/CLI only; no HTTP fetch in codex-rs/features/src/lib.rs) |
| codex-agent-identity, codex-workload-identity, codex-aws-auth, codex-secrets, codex-keyring-store | — | 892/736/328/861/200 | programmatic identity, token exchange, SigV4, secret storage |
| codex-diagnostics, codex-terminal-detection, codex-install-context, codex-file-search, codex-file-system, codex-git-utils, codex-memories-read, codex-agent-graph-store, codex-context-fragments, codex-response-debug-context, codex-websocket-client, codex-async-utils, codex-experimental-api-macros, codex-collaboration-mode-templates, + 15 `utils/*` crates | — | ~12k combined | support |

### 1.2 Droppable: not in the closure (63 crates)

Frontends and daemons: `codex-tui`, `codex-cli`, `codex-exec`, `codex-app-server`, `codex-app-server-client`, `codex-app-server-daemon`, `codex-app-server-transport`, `codex-app-server-test-client`, `codex-ansi-escape`, `codex-arg0`, `codex-process-hardening`, `codex-stdio-to-uds`, `codex-uds`, `codex-file-watcher`, `codex-message-history`, `codex-build-info`, `codex-mcp-server`, `codex-external-agent-migration`, `codex-thread-manager-sample`, `codex-v8-poc`.

OpenAI-service and alt-runtime shims: `codex-chatgpt`, `codex-backend-client`, `codex-backend-openapi-models`, `codex-cloud-config`, `codex-cloud-tasks(-client/-mock-client)`, `codex-responses-api-proxy` (a local proxy binary that injects `Authorization` headers; consumed only by `codex-cli`), `codex-ollama`, `codex-lmstudio`, `codex-utils-oss`, `codex-home` (consumed only by app-server/cli/core-api/mcp-server).

Optional extensions (each consumes core, not vice versa): `ext/agent`, `ext/connectors`, `ext/git-attribution`, `ext/goal`, `ext/guardian`, `ext/guardian-v2`, `ext/image-generation`, `ext/mcp`, `ext/memories`, `ext/queue`, `ext/web-search`, `memories/write`, `codex-linux-sandbox` (the arg0-dispatch sandbox *binary*; the landlock/bwrap *logic* is in `sandboxing`, which is in the spine), `codex-bwrap`, plus assorted `utils/*` and test-support crates.

Note `codex-core-api` (the "public facade for thread management APIs built on codex-core", codex-rs/core-api/src/lib.rs:1) is only 124 lines of re-exports and is consumed only by `codex-thread-manager-sample` — the embedding surface Atlas would talk to is really `codex_core::CodexThread` (codex-rs/core/src/codex_thread.rs:166) directly.

### 1.3 "Mandatory-looking but actually optional"

**Nothing is optional via cargo machinery.** The closure with and without `optional = true` deps is identical, and `codex-core` has no `[features]`. Concretely surprising hard deps of the engine:

- `codex-windows-sandbox` (17.4k LOC, 307 `unsafe`) is unconditional even on macOS/Linux builds (codex-rs/core/Cargo.toml:86).
- `codex-app-server-protocol` (28k LOC) — core is coupled to the app-server's notification types (e.g. `ServerNotification` consumed by analytics, codex-rs/analytics/src/client.rs:640-672).
- `codex-analytics`, `codex-otel`, `codex-network-proxy`, `codex-code-mode`, `codex-exec-server` — all wired into `Session` construction (codex-rs/core/src/session/session.rs:1190-1196 for analytics; others throughout core).

Any "minimal" port is therefore the full 77-crate closure on day one, slimmed afterwards by editing core, not by flipping features.

## 2. Provider depth

### 2.1 Is `model-provider` a real abstraction?

It is a genuine trait, but scoped to auth + capabilities + model catalogs, not the wire:

- `pub trait ModelProvider` — codex-rs/model-provider/src/provider.rs:120-250. Methods: `info()` (returns the *config struct* `ModelProviderInfo`), `capabilities()`, `auth_manager()`, `auth()`, `api_auth()`/`api_auth_for_scope()`, `models_manager*()`, plus preferred-model overrides for review/memory sub-tasks (provider.rs:103-113 hardcode `"codex-auto-review"`, `"gpt-5.6-luna"`, `"gpt-5.6-terra"`).
- Exactly **two implementations**: `ConfiguredModelProvider` (provider.rs:279, the OpenAI-compatible default selected for everything) and `AmazonBedrockModelProvider` (provider.rs:270-275; codex-rs/model-provider/src/amazon_bedrock/mod.rs). The Bedrock impl serves *OpenAI GPT models hosted on Bedrock* — its model IDs are `AMAZON_BEDROCK_GPT_5_6_*` constants (amazon_bedrock/mod.rs:17-20) — with SigV4 signing via `codex-aws-auth` (codex-rs/aws-auth/src/lib.rs:1-8). It is an alternate *transport/auth*, not an alternate model API.
- The wire protocol selector, `WireApi`, has **one variant**:
  ```rust
  pub enum WireApi {
      /// The Responses API exposed by OpenAI at `/v1/responses`.
      #[default]
      Responses,
  }
  ```
  codex-rs/model-provider-info/src/lib.rs:61-65. There is no chat-completions (or any second) wire format at this commit.
- `ModelProviderInfo` itself (codex-rs/model-provider-info/src/lib.rs:93-138) is config-shaped glue: `base_url`, `env_key`, `experimental_bearer_token`, headers, retry/stream-timeout knobs, `requires_openai_auth`.

**Verdict:** pluggable auth and endpoints over exactly one wire dialect. "Provider" in codex means "an OpenAI-Responses-compatible URL with some way to get a bearer token."

### 2.2 Does codex-core speak the Responses API specifically?

Yes — at three layers, including persistence:

1. **Request side.** `ResponsesApiRequest` (codex-rs/codex-api/src/common.rs:252-275): `model`, `instructions`, `input: Vec<ResponseItem>`, `tools` (pre-serialized raw JSON via `ResponsesApiTools(Arc<RawValue>)`, common.rs:222), `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `include`, `service_tier`, `prompt_cache_key`, `text`. A websocket variant maps from it (common.rs:277-300).
2. **Stream side.** The SSE parser matches raw Responses event names — `"response.output_item.done"`, `"response.output_text.delta"`, `"response.reasoning_summary_text.delta"`, `"response.reasoning_text.delta"`, `"response.created"`, `"response.failed"`, `"response.incomplete"`, `"response.completed"`, `"response.output_item.added"`, `"response.reasoning_summary_part.added"` — codex-rs/codex-api/src/sse/responses.rs:352-497. These become `ResponseEvent` (codex-rs/codex-api/src/common.rs:76-123), which is only nominally "normalized": it carries `ServerModel` (from the `OpenAI-Model` response header, common.rs:81-82), `SafetyBuffering` (backend safety routing with a `retry_model`, common.rs:126-133), `ModelVerifications`, `ServerReasoningIncluded` (from `X-Reasoning-Included`), `ReasoningSummaryDelta { summary_index }`, `ReasoningContentDelta { content_index }`, `RateLimits`, `ModelsEtag`.
3. **Consumption + persistence.** The turn loop consumes every variant in `codex-rs/core/src/session/turn.rs:2260-2690` (one match arm per `ResponseEvent`), and the stream driver in `codex-rs/core/src/client.rs:1827, 2007-2093` handles retry/completed bookkeeping. `ResponseItem` (codex-rs/protocol/src/models.rs:846-onward) is simultaneously (a) the request `input`, (b) the streamed output item, and (c) the on-disk history format — rollout files store `RolloutItem::ResponseItem` (codex-rs/rollout/src/list.rs:1232, codex-rs/rollout/src/policy.rs:5). Its variants are Responses item types verbatim: `Message`, `Reasoning { summary, content, encrypted_content }`, `LocalShellCall`, `FunctionCall { arguments: String /* "The Responses API returns the function call arguments as a *string*" — models.rs comment */ }`, `FunctionCallOutput`, `CustomToolCall`, `ToolSearchCall`, etc.

### 2.3 What the ollama crate actually does

Shallow. 1,107 total lines (all of `codex-rs/ollama/src`). It: probes a local Ollama server, lists models, pulls `gpt-oss:20b` by default with progress reporting (`ensure_oss_ready`, codex-rs/ollama/src/lib.rs:22-45; pull.rs). It contains **no request serialization, no stream parsing, no tool plumbing**. The actual conversation happens because Ollama ≥ 0.13.4 implements the Responses API itself — `min_responses_version()` returns 0.13.4 (codex-rs/ollama/src/lib.rs:46-48) — and core talks to it through the ordinary `ConfiguredModelProvider` with `create_oss_provider_with_base_url(..., WireApi::Responses)` (used e.g. in codex-rs/model-provider/src/provider.rs:568). So the OSS path is not evidence that a non-Responses provider works; it is evidence that only Responses-speaking servers work.

### 2.4 What concretely breaks with the Anthropic Messages API

Driving this engine with Anthropic's API means building the missing second wire dialect. Touchpoints:

1. **Request serialization** — `ResponsesApiRequest` and the endpoint builders (codex-rs/codex-api/src/endpoint/responses.rs, requests/) would need an Anthropic counterpart: `system` vs `instructions`, `messages` with content blocks vs flat `input: Vec<ResponseItem>`, `max_tokens` (mandatory for Anthropic, absent here), no `store`/`include`/`service_tier`/`parallel_tool_calls`.
2. **Stream parsing** — a new SSE state machine: Anthropic's `message_start`/`content_block_start`/`content_block_delta`/`message_delta` vs the `response.*` names in codex-rs/codex-api/src/sse/responses.rs:352-497. Mapping onto `ResponseEvent` is feasible but lossy/awkward: `summary_index`/`content_index` reasoning-summary semantics, `ServerModel`, `SafetyBuffering`, `ModelVerifications`, `ServerReasoningIncluded` have no Anthropic equivalent; `end_turn` maps from Anthropic `stop_reason`.
3. **History/item model** — the hard one. `ResponseItem` is the internal IR *and* the persisted rollout format (§2.2.3). Anthropic `tool_use`/`tool_result` blocks must round-trip through `FunctionCall { arguments: String, call_id }` / `FunctionCallOutput` — shape-compatible in principle, but every replay/compaction/truncation path in core assumes Responses semantics (e.g. reasoning replay via `encrypted_content`, protocol/src/models.rs Reasoning variant). Anthropic's equivalent is thinking blocks with `signature`, which do not fit `encrypted_content: Option<String>` without a mapping decision.
4. **Tool definitions** — tools are serialized once into raw OpenAI-format JSON (`ResponsesApiTools`, codex-rs/codex-api/src/common.rs:222) from specs in codex-rs/core/src/tools + codex-rs/tools. Anthropic wants `{name, description, input_schema}`; also codex's built-in special tool types (`local_shell`, `apply_patch` grammar tool, web_search) are Responses-native.
5. **Token accounting** — `TokenUsage` is populated from the `response.completed` payload (codex-rs/codex-api/src/sse/responses.rs:455-…; surfaced as `ResponseEvent::Completed { token_usage }`, common.rs:91-98). Anthropic reports usage incrementally in `message_start`/`message_delta`. Rate-limit snapshots (`ResponseEvent::RateLimits`) parse OpenAI rate-limit headers.
6. **Model metadata** — the catalog is OpenAI-shaped: bundled codex-rs/models-manager/models.json (slugs, reasoning levels, `instructions_template`, truncation policies, context windows) refreshed from the provider's `/models` endpoint (`OpenAiModelsEndpoint`, codex-rs/model-provider/src/models_endpoint.rs; wired in provider.rs:401-410). Anthropic model metadata would have to be authored into a static catalog (the `StaticModelsManager` path, provider.rs:230-234, exists and helps).
7. **Provider-gated features degrade already** — remote compaction is capability-gated to OpenAI/Azure (`RemoteCompactionSupport::Unsupported` otherwise, codex-rs/model-provider/src/provider.rs:300-306), so those paths turn off rather than break.
8. **Headers/identity** — `originator`, session/thread headers (codex-rs/codex-api/src/requests/headers.rs:5), `User-Agent` (§3.4) would be replaced wholesale.

**Practical seam:** keep `ResponseEvent`/`ResponseItem` as the internal IR (the turn loop and persistence already depend on them) and add an Anthropic endpoint+SSE module inside `codex-api` behind a real second `WireApi` variant. That is new code at the `codex-api` layer plus catalog data, not a rewrite of core — but nothing in the repo has done it before, so Atlas would be the first consumer of a "second dialect" seam that exists only implicitly.

## 3. Identity surface

| Item | Where | Classification |
|---|---|---|
| `CODEX_HOME` env var, `~/.codex` default dir | codex-rs/utils/home-dir/src/lib.rs:14 (env), :59 (`.codex` fallback) | **Rename** (one function; everything downstream takes the resolved path) |
| `codex-home` crate | codex-rs/codex-home (instructions assets) — *not in the spine*; consumed only by app-server/cli/core-api/mcp-server | **Drop** |
| ChatGPT OAuth + device-code login | codex-rs/login/src (pkce.rs, device_code_auth.rs, server.rs); success page redirects to `https://chatgpt.com/codex/open-app` (login/src/success_page.rs:7); JWT claims keyed by `https://api.openai.com/auth` / `.../profile` (login/src/token_data.rs:75-77) | **Rip out** (dormant if unused, but it is spine code — `codex-login` is a required dep of core) |
| Auth modes | `AuthMode` (codex-rs/protocol/src/auth.rs:9): ApiKey, Chatgpt, ChatgptAuthTokens, Headers, AgentIdentity, (+PersonalAccessToken); `CodexAuth` runtime enum (codex-rs/login/src/auth/manager.rs:76-84) adds BedrockApiKey | keep `ApiKey`, rip out the rest |
| `workload-identity`, `aws-auth`, `agent-identity`, `keyring-store`, `secrets` | codex-rs/workload-identity (token exchange), aws-auth (SigV4), agent-identity (programmatic identity JWTs) — all in the spine | **Rip out** (small: 0.7k/0.3k/0.9k LOC) |
| OTLP metrics to Statsig | `STATSIG_OTLP_HTTP_ENDPOINT = "https://ab.chatgpt.com/otlp/v1/metrics"` + hardcoded `STATSIG_API_KEY = "client-MkRule…"` (codex-rs/otel/src/config.rs:9-11); the `Statsig` exporter resolves to `None` in debug builds only (config.rs:17-22) | **Rip out** |
| Analytics events | Client created for **every session**: `AnalyticsEventsClient::new(auth_manager, config.chatgpt_base_url, config.analytics_enabled)` (codex-rs/core/src/session/session.rs:1190-1196); posts to `{base}/codex/analytics-events/events` (codex-rs/analytics/src/client.rs:124); `chatgpt_base_url` defaults to `https://chatgpt.com/backend-api/` (codex-rs/core/src/config/mod.rs:4089); queue exists unless `analytics_enabled == Some(false)` (client.rs:230); on send, ChatGPT-auth sends everything, plain API-key auth still sends the `can_send_with_api_key_auth` subset (client.rs:684-691) | **Rip out** |
| Originator header | `DEFAULT_ORIGINATOR = "codex_cli_rs"`, override env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, residency header `x-openai-internal-codex-residency` (codex-rs/login/src/auth/default_client.rs:40-42) | **Rename** |
| User-Agent | `"{originator}/{version} ({os} {ver}; {arch}) {terminal}"` (codex-rs/login/src/auth/default_client.rs:159-170) | **Rename** |
| Baked system prompt | `BASE_INSTRUCTIONS = include_str!("../prompt.md")` (codex-rs/models-manager/src/model_info.rs:17); prompt.md line 1: "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI." | **Rename** (rewrite text) |
| Per-model prompts in the catalog | `instructions_template` fields inside codex-rs/models-manager/models.json (e.g. line 704: "You are GPT-5.2 running in the Codex CLI…"); the same catalog shape is refreshed from the provider `/models` endpoint at runtime, so identity text can arrive **from the backend** too | **Rename** in bundled data; note remote-catalog implication for Atlas's provider |
| Loose prompt files | codex-rs/core/gpt_5_codex_prompt.md, gpt-5.1-codex-max_prompt.md, gpt_5_2_prompt.md, prompt_with_apply_patch_instructions.md — "You are Codex, based on GPT-5…" — **no `include_str!` reference from Rust found at this commit**; apparently reference/data copies of the catalog templates | delete or rewrite; not load-bearing as far as I can determine |
| Guardian policy, agent roles, misc embedded data | codex-rs/core/src/guardian/prompt.rs:819-820 (policy.md), core/src/agent/role.rs:449-450, core/src/agent/control/spawn.rs:11 | audit text during rebrand |
| Feature flags | `codex-features` is **local-only** (config.toml `[features]` + `--enable`; no HTTP in codex-rs/features/src/lib.rs; the only URL is a docs link at lib.rs:649) | keep |
| Backend-fetched config | `codex-backend-client` (ChatGPT backend API), `codex-chatgpt`, `codex-cloud-config`, `codex-responses-api-proxy` are **all outside the spine** (§1.2). Inside the spine, the only backend-shaped fetches are the provider `/models` catalog (works against any provider; bundled fallback exists) and the analytics/otel uploads above | drop / rip out respectively |

### Distance from Atlas's BYOK model

Short. The provider config already supports exactly Atlas's shape with **no login flow**:

- `requires_openai_auth: false` (the default) skips the login screen entirely — "If false (which is the default), login screen is skipped" (codex-rs/model-provider-info/src/lib.rs:136-138).
- The key arrives either via `env_key` (an env var name; read at request time by `ModelProviderInfo::api_key()`, codex-rs/model-provider-info/src/lib.rs:290-296) or via `experimental_bearer_token` (a literal token in the provider config, "necessary when using this programmatically", lib.rs:105-108).
- Atlas's settings UI therefore needs to construct a `ModelProviderInfo { base_url, experimental_bearer_token: Some(key), requires_openai_auth: false, wire_api: Responses, .. }` — or add a first-class "injected key" field, a few lines in `resolve_provider_auth` (codex-rs/model-provider/src/auth.rs). This matches the seam already stubbed in Atlas: the native agent "authenticates with BYOK keys from Atlas's settings, not with an ACP auth method" (crates/atlas-native-agent/src/lib.rs:28-30 in the Atlas repo).
- What BYOK does **not** remove by itself: the `login` crate stays in the build (auth manager types are threaded through core and the `ModelProvider` trait — `auth_manager()` returns `Arc<codex_login::AuthManager>`, codex-rs/model-provider/src/provider.rs:161), and the sub-task model names `codex-auto-review`/`gpt-5.6-luna`/`gpt-5.6-terra` (provider.rs:103-113) must be repointed at Atlas's provider's models.

## 4. License + attribution

**License:** Apache-2.0, at repo root `LICENSE`; declared once at workspace level (`license = "Apache-2.0"`, codex-rs/Cargo.toml:147) and inherited per-crate via `license.workspace = true` (e.g. codex-rs/core/Cargo.toml, codex-rs/protocol/Cargo.toml). No other license was found on the Rust crates.

**NOTICE file** (repo root, quoted in full):

> OpenAI Codex
> Copyright 2025 OpenAI
>
> This project includes code derived from [Ratatui](https://github.com/ratatui/ratatui), licensed under the MIT license.
> Copyright (c) 2016-2022 Florian Dehau
> Copyright (c) 2023-2025 The Ratatui Developers

(The Ratatui portion pertains to the TUI; if the TUI is dropped, §4(d) permits excluding notices "that do not pertain to any part of the Derivative Works" — retaining it anyway is harmless and simpler.)

**Obligation-bearing terms for a renamed one-time port** (LICENSE, quoted):

- §4 Redistribution: "You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications … provided that You meet the following conditions:
  (a) You must give any other recipients of the Work or Derivative Works a copy of this License; and
  (b) You must cause any modified files to carry prominent notices stating that You changed the files; and
  (c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and
  (d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file …"
  §4 also confirms: "You may add Your own copyright statement to Your modifications and may provide additional or different license terms … for Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies …"
- §6 Trademarks: "This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file."
- §3 Patent: a "perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable" patent license from each contributor, terminating for anyone who "institute[s] patent litigation … alleging that the Work or a Contribution … constitutes direct or contributory patent infringement."

**Go/no-go: GO.** The plan in ADR-0003 (ship LICENSE + NOTICE, change notices on modified files, strip Codex/OpenAI *branding* while keeping *attribution*) is precisely what §§4 and 6 require and permit. The rebrand is not only allowed but arguably mandated by §6: Atlas must **not** market the port under the "Codex" or "OpenAI" marks.

## 5. Ownership cost

### 5.1 The smallest coherent subset, quantified

The smallest subset that runs an agent turn **as the code is written today** is the full required closure:

> **77 crates · 1,684 Rust files · ~599,800 LOC** (non-blank, non-comment, `tests/` dirs excluded; ~744,700 including `tests/` dirs). `codex-core` alone is 425 files / ~174,600 LOC.

There is no smaller cargo-resolvable subset — no features, no optional deps (§1.3). A genuinely smaller engine requires editing core to sever crates; the plausible first cuts and their savings: windows-sandbox (17.4k, if Windows is out of scope), analytics (12.5k), network-proxy (15.7k), code-mode (+protocol, 12.3k), core-plugins/marketplace (36.9k), hooks (11.7k), skills-extension (15.5k), connectors (4.4k), otel (4.1k) — roughly 130k LOC of surgery-recoverable weight, each cut touching call sites inside core.

### 5.2 Per-crate ownability (spine, grouped)

- **codex-core (174.6k)** — the real liability. It is a competent but sprawling monolith: session/turn/tooling plus compaction (five `compact_remote*` modules), delegate/multi-agent support (`core/src/agent`), guardian, realtime conversation, plugins glue. A small team can own the turn loop and tools; owning *all* of it means owning many features Atlas will never surface. Expect the port's long tail to live here.
- **codex-protocol (20.4k)** — clean serde/type crate; derives `TS` (ts-rs) and `JsonSchema`, i.e. TypeScript bindings are **generated from Rust**, not from an external schema. Self-contained and very ownable; churn only when Atlas changes the protocol itself.
- **codex-api + codex-client + http-client (~18.9k)** — well-factored wire layer (request builders, SSE parser, retry policy at codex-rs/codex-client/src/retry.rs, websocket variants). This is the layer Atlas must modify hardest (Anthropic dialect) and it is fortunately the most readable.
- **model-provider / model-provider-info / models-manager (~7k)** — small, config-shaped, easily owned; the bundled models.json is data Atlas rewrites anyway.
- **login (11.3k)** — mostly ChatGPT OAuth machinery Atlas rips out; the parts that stay (AuthManager, ApiKey auth, default_client UA/originator) are a fraction of it.
- **rollout / rollout-trace / thread-store / history / state (~69.9k)** — persistence stack. `state` pins bundled SQLite ≥ 3.51.3 with a compile-time assert citing "the WAL-reset corruption fix" (codex-rs/state/src/lib.rs:7-10) — a hint this layer has already eaten subtle storage bugs. Coherent, documented module headers, ownable but large; overlaps conceptually with Atlas's own app-owned thread-metadata store (ADR-0001), so expect either duplication or a deliberate mapping.
- **config (19.9k)** — TOML layer stack + profiles; verbose but shallow; much of it (TUI keymaps, notification settings) is dead weight for Atlas.
- **exec-server (27k) + exec-server-protocol + utils/pty (4k)** — process execution environments, capability discovery, PTYs. Platform-sensitive (91 `unsafe` in pty), the kind of code where bugs are timing-dependent. Second-highest ownership risk after core.
- **sandboxing (6.4k) + windows-sandbox-rs (17.4k) + execpolicy + shell-*** — macOS Seatbelt via embedded `.sbpl` policy files (codex-rs/sandboxing/src/seatbelt_base_policy.sbpl etc.), Linux Landlock + bwrap, Windows via a 307-`unsafe` Win32 crate. This is exactly the code the one published CVE lived in (below). Security-critical, platform-trifurcated, and Atlas owns every escape after cutover. Highest-severity risk pound-for-pound.
- **network-proxy (15.7k)** — MITM-capable proxy with certificate generation (codex-rs/network-proxy/src/certs.rs, mitm.rs). Security-sensitive; Atlas should decide early whether its sandbox story needs it at all.
- **mcp + rmcp-client (29.8k)** — MCP stack on the `rmcp` ecosystem; protocol churn risk is external (MCP spec) rather than OpenAI-specific; ownable.
- **core-plugins (36.9k), skills(-extension) (18k), hooks (11.7k), code-mode (12.3k), connectors (4.4k)** — codex's own convention/extension surfaces. Self-contained, but they overlap with Atlas's existing skills/packs direction; carrying both conventions is a product decision, not just code cost.
- **app-server-protocol (28k)** — types-only but big; generated TS bindings; a candidate for aggressive pruning since Atlas's UI speaks ACP through `atlas-native-agent`, not codex's app-server protocol.
- **otel (4.1k), analytics (12.5k), feedback (1k)** — rip-outs (§3); until ripped out, they are live phone-home code Atlas is responsible for.
- **~25 small utils/support crates (~12k combined)** — trivial to own.

### 5.3 Unusually gnarly, flagged

1. **Platform sandboxing trifecta** — Seatbelt `.sbpl` policy language, Landlock/seccomp-adjacent Linux code, bwrap, plus the separate Windows sandbox crate with 307 `unsafe` sites. Deep OS-specific expertise required; the historical CVE was here.
2. **Heavy `unsafe` concentrations** — windows-sandbox-rs (307), utils/pty (91); core itself is nearly clean (16).
3. **Generated/derived artifacts** — TS bindings generated from `codex-protocol`/`app-server-protocol` via ts-rs, JsonSchema derives; bundled `models.json` doubles as behavior (prompts, truncation policies, context windows). No externally-generated schemas flow *into* the Rust (good: no upstream codegen dependency).
4. **OpenAI-backend-shaped code inside the spine** — analytics/otel uploads (hardcoded Statsig key), remote-compaction endpoints, `SafetyBuffering`/`ModelVerifications` event handling, agent-identity/workload-identity token exchange. All rip-out-able, but each is wired into `Session`.
5. **Hardwired sub-task models** — review/memory/compaction paths name `gpt-5.6-luna`/`terra`/`codex-auto-review` (codex-rs/model-provider/src/provider.rs:103-113); silent breakage risk when repointed at a non-OpenAI provider.
6. **SQLite pin** — bundled libsqlite3 version assert (codex-rs/state/src/lib.rs:7-10); Atlas inherits the responsibility of tracking SQLite corruption fixes.

### 5.4 Security advisory history

`gh api repos/openai/codex/security-advisories` returns **one published advisory**:

- **GHSA-w5fx-fh39-j5rw / CVE-2025-59532** — "Sandbox bypass due to bug in path configuration logic": a model-generated `cwd` could be treated as the sandbox's writable root, enabling arbitrary file writes/command execution outside the workspace. Severity high, CVSS v4 8.6. Patched in Codex CLI 0.39.0 (published 2025-09-19) — long before the 2026-08-14 fork point, so the fix is in the ported code.

One advisory in the project's lifetime, in exactly the subsystem flagged above. After cutover Atlas receives no further advisories automatically; ADR-0003's accepted obligation to watch `https://github.com/openai/codex/security/advisories` (and plausibly the Seatbelt/Landlock ecosystems directly) is the mitigation.

## Open questions

1. **Default OTel exporter state in release builds.** The Statsig exporter hardcodes endpoint+key and is forced off in debug builds (codex-rs/otel/src/config.rs:17-22), but I did not trace which exporter the default `OtelConfig` selects in a release build with default config — i.e., whether metrics upload is on-by-default or opt-in. Verify before assuming "rename only the analytics path."
2. **Bedrock wire translation.** `amazon_bedrock/mantle.rs` and `runtime.rs` were not read in depth; whether Bedrock requests are Responses-payloads-inside-SigV4 or a translated shape is undetermined. Matters only as prior art for "second transport" work.
3. **`codex-feedback` and `codex-connectors` network behavior.** Both are in the spine; their endpoints and default-on/off state were not traced. Assume backend-facing until audited.
4. **The loose `core/*.md` prompt files** appear unreferenced from Rust at this commit (no `include_str!` hits); whether some build step (Bazel) or eval harness consumes them was not verified.
5. **True post-surgery LOC.** ~600k is the honest day-one number; the ~470k after the cuts listed in §5.1 is an estimate, not a measurement — each cut needs core call-site work that could ripple.
6. **`codex-exec-server` necessity.** Whether core can run tools without the exec-server environment layer (e.g. a degenerate in-process environment) was not determined; it is a required dep and assumed load-bearing.
7. **Remote model catalog vs Anthropic.** If Atlas's provider does not serve an OpenAI-shape `/models`, the `StaticModelsManager` path covers it — but which callers insist on the remote path at runtime was not exhaustively traced.
