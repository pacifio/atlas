# Native agent × Atlas gateway: why Gemini tool calls 400 on the second turn, and why GLM cannot say "Hello"

**Date:** 2026-09-08.

**Question.** Two user-reported failures in the native-agent ("Atlas Agent") chat UI, both on the Chat Completions dialect against the Atlas AI gateway:

1. **Gemini 3.6 Flash / Gemini 3.5 Flash Lite, with tools.** The model streams a text preamble, emits one tool call, the tool runs ("Tool calls 6s 1 call"), and the turn ends with `Error: stream disconnected before completion: The upstream provider failed (400).`
2. **GLM 5.3 Flash, plain "Hello".** The turn ends with `Error: stream disconnected before completion: the model stream carried a frame this client could not read (invalid type: null, expected a sequence at line 1 column 219), so the answer may be incomplete`.

What does the client actually send and expect, what does the gateway do with it, and what is the most likely root cause of each?

**Sources.** Client: `vendor/codex/codex-api/src/atlas_chat/{request,sse}.rs` and their `*_tests.rs`, `vendor/codex/codex-api/src/atlas_gateway.rs`, `vendor/codex/codex-api/src/api_bridge.rs`, `vendor/codex/core/src/client.rs`, `crates/atlas-native-agent/src/engine/catalog.rs` — all in this repo. Gateway: `~/Codes/atlas-server-ref/apps/ai/src/{index,broker,gateway,metering}.ts` and `~/Codes/atlas-server-ref/packages/contracts/src/ai.ts` (the `atlas-server-ref` checkout at `a619e33`, 2026-09-03; cited as `gw:`). Provider behaviour: official docs only, listed in §7. Claims are tagged **MEASURED** (read off code or docs), **INFERRED** (a reconstruction that fits the evidence), or **UNVERIFIED**.

## TL;DR

1. **Both failures are provider-shape mismatches on the one wire the engine speaks, not engine bugs.** The gateway forwards the client's `messages`/`tools` verbatim and passes the provider's SSE bytes through untouched (§2), so what Vertex and Workers AI accept or emit reaches the client raw.
2. **GLM — most likely `"tool_calls": null` in a `delta`, from Cloudflare Workers AI's serving stack.** The client's `ChatDelta.tool_calls` is a `Vec` with `#[serde(default)]` (sse.rs:133-134), which covers a *missing* key and fails on a present `null` — a behaviour the test suite pins on purpose (sse_tests.rs:459-471). serde_json reports the column of the *last* byte of the offending token (measured, §4.2), so the `null` sits at columns 216–219; that position fits `choices[0].delta.tool_calls: null` in a first chunk with a 33–40-character `id` and does not fit `choices: null` in a usage-only chunk (§4.3). Cloudflare publishes **no** streaming chunk schema for this model (§4.4), OpenAI's reference says `delta.tool_calls` is optional and *not nullable* (§4.4), and Z.ai's own API never emits it as `null` (§4.4) — so the `null` is an artefact of whatever OpenAI-shim Workers AI runs, which is undocumented. **Fix is client-side leniency** (§6.1): a `null`-tolerant deserializer on every array field of the chunk.
3. **Gemini — the second request is the only thing that changed, so the 400 is in the replayed tool-call history, not the tool schemas.** Turn 1 and turn 2 carry the identical `tools` array (client.rs:1470-1490) and turn 1 succeeds, which excludes JSON-Schema keyword rejection. What turn 2 adds is one assistant message `{"role":"assistant","tool_calls":[{"id":…,"type":"function","function":{"name":…,"arguments":…}}]}` with **no `content` key** and **no thought signature**, followed by `{"role":"tool","tool_call_id":…,"content":…}` (§3.1). Ranked causes in §3.3, led by Gemini 3's thought-signature requirement on function calls (see the primary-source notes in §3.2).
4. **The UI cannot say which, because the client throws the diagnosis away.** The gateway answers an upstream 400 with `502 provider_error` whose body carries the provider's own error under `error.upstream` (gw:gateway.ts:349-360); the client's `GatewayError` struct reads `message`, `code` and the cap fields only (atlas_gateway.rs:68-86), so `upstream` is dropped, the 502 is classified `RetryCautiously`, retried up to 5 times (`DEFAULT_STREAM_MAX_RETRIES`), and surfaced as `CodexErr::Stream("The upstream provider failed (400).")` (§2.3). Reading `error.upstream` into the message is the single cheapest change in this document and is what turns the next report from a guess into a fact.
5. **Confirm before fixing Gemini.** One capture of the gateway's 502 body for a failing turn (or of Vertex's response to the replayed request) decides between the ranked causes in §3.3; §5 lists three ways to get it, the fastest being `CODEX_ROLLOUT_TRACE_ROOT` (§5.1).

---

## 1. Where the two error strings come from

Both messages are `CodexErr::Stream`, whose `Display` is `"stream disconnected before completion: {0}"` (`vendor/codex/protocol/src/error.rs:92`). The inner text is different for the two failures:

| Failure | Inner text minted at | Path to `CodexErr::Stream` |
|---|---|---|
| Gemini | `gw:apps/ai/src/gateway.ts:356` — `` `The upstream provider failed (${upstream.status}).` `` | Gateway returns HTTP `502 provider_error` (§2.3) → `ConfiguredModelProvider::map_api_error` (`vendor/codex/model-provider/src/provider.rs:319-346`) → `atlas_gateway::classify` `(502, _) => RetryCautiously { message }` (`atlas_gateway.rs:186`) → `Disposition::into_api_error` → `ApiError::Retryable` (`atlas_gateway.rs:262-267`) → `map_api_error` → `CodexErr::Stream(message)` (`api_bridge.rs:25-31`) |
| GLM | `vendor/codex/codex-api/src/atlas_chat/sse.rs:333-336` — `"the model stream carried a frame this client could not read ({err}), so the answer may be incomplete"` | `serde_json::from_str::<ChatChunk>` fails (sse.rs:321) → recorded as `stream_error` and the loop keeps scanning (sse.rs:332-338) → raised on stream close with no `[DONE]`, or on `[DONE]` (sse.rs:278-289, 300-308) → `ApiError::Stream` → `CodexErr::Stream` (`api_bridge.rs:32`) |

**MEASURED.** The `graphify query` for this question returned unrelated nodes (the graph does not index `vendor/codex`), so every citation here is from reading the files.

## 2. What the gateway does with a chat-dialect request

The gateway is `atlas-ai`, a Cloudflare Worker (`gw:apps/ai`). Facts that matter for both failures:

### 2.1 Routing — two providers, one compat endpoint, verbatim bodies

- **Gemini** rows are `provider = google-vertex-ai`, addressed to Cloudflare AI Gateway's OpenAI-compatible endpoint `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions` with model `google-vertex-ai/google/gemini-3.6-flash` (`gw:gateway.ts:57-64`; `gw:test/workers-ai.test.ts:143-146`). The gateway doc records that Vertex's *own* OpenAI surface (`…/locations/global/endpoints/openapi/chat/completions`) refuses Claude identically to the compat endpoint (`gw:docs/api/atlas-ai-api.md` §4.3a), which is the evidence that the compat endpoint fronts Vertex's OpenAI-compatible chat completions surface for Google models.
- **GLM** — `glm-5.3-flash` is **not Zhipu's API**. It is Cloudflare Workers AI model `@cf/zai-org/glm-5.3-flash`, addressed to the *same* compat endpoint with model `workers-ai/@cf/zai-org/glm-5.3-flash` and `CF_AIG_TOKEN` in the provider `Authorization` slot (`gw:gateway.ts:165-180`; `gw:test/workers-ai.test.ts:112-122`; commit `4ae40bd` "serve GLM-5.3 Flash … through AI Gateway"). The client-side catalogue says so too (`crates/atlas-native-agent/src/engine/catalog.rs:57-66`).
- **The body is forwarded as-is.** `toGatewayRequest` spreads `...request`, overrides `model` and `max_tokens`, and forces `stream_options: {include_usage: true}` on streamed calls (`gw:broker.ts:191-211`). The zod schema validates the top-level allowlist only; `messages` and `tools` are `z.array(LooseObject)` — "left deliberately unvalidated beyond 'an object'" (`gw:packages/contracts/src/ai.ts:48-86`). So the assistant `tool_calls` message and the `tool` messages the client builds (§3.1) reach Cloudflare, and therefore Vertex, byte-for-byte.

### 2.2 The stream is passed through untouched

For the chat dialect the response body is `upstream.body` — the Anthropic and Responses dialects are rewritten frame-by-frame, chat is not (`gw:index.ts:852-860`). `meterStream` reads usage out of the bytes as they flow and enqueues the *same* `Uint8Array` it read (`gw:metering.ts:310-320`); the only frame it ever synthesises is a `502 provider_error` error frame when the upstream reader throws (`gw:metering.ts:321-332`). The gateway doc: "passed through incrementally — never buffered" (`gw:docs/api/atlas-ai-api.md` §5). **Consequence:** whatever JSON Workers AI emits for GLM is exactly what `serde_json` sees in sse.rs:321.

### 2.3 An upstream 400 becomes a 502 whose detail the client discards

- On `!upstream.ok` the gateway releases the reservation and calls `classifyFailure` (`gw:index.ts:745-753`). A non-429 native provider error is answered as `aiError(502, providerError, "The upstream provider failed (400).", { upstream: parsed ?? text.slice(0, 2048) })` (`gw:gateway.ts:349-360`) — i.e. the body is `{"error":{"message":"The upstream provider failed (400).","type":…,"code":"provider_error","param":null,"upstream":<Vertex's error body>}}` (`gw:errors.ts:34-52`). The gateway doc: "`error.upstream` carries the provider's body (capped at 2 KB)" (`gw:docs/api/atlas-ai-api.md` §9 table, line 807).
- The client deserialises that body into `GatewayEnvelope { error: GatewayError { message, code, window, scope, used, cap, reset } }` (`atlas_gateway.rs:63-86`). There is no `upstream` field, so the provider's diagnosis — the one string that says *why* Vertex refused — is dropped on the floor. The user sees only the gateway's outer sentence.
- Because a 502 is `RetryCautiously` (`atlas_gateway.rs:186`) and `ApiError::Retryable` maps to a retryable `CodexErr::Stream` (`api_bridge.rs:25-31`; `protocol/src/error.rs:362-397`), the turn loop re-sends the identical request up to `stream_max_retries()` = 5 times (`model-provider-info/src/lib.rs:27, 333-336`; `core/src/session/turn.rs:1347-1420`). A deterministic provider 400 therefore costs six gateway round-trips and ~6 s of "Reconnecting…" before the error surfaces. The inference-trace attempt records only `error.to_string()` (`rollout-trace/src/inference.rs:239-262`), so the `upstream` detail is not persisted there either.

## 3. Failure 1 — Gemini tool calls

### 3.1 What the client sends on the second turn (MEASURED)

`build_chat_request` (`request.rs:203-253`) replays the whole `ResponseItem` history every turn (the engine is stateless; `core/src/client.rs:1470-1490` rebuilds `items` from `prompt.get_formatted_input_for_request`). The relevant serialisation, from the `ChatMessage` enum (`request.rs:131-152`) and `push_item` (`request.rs:317-412`):

| Engine item | Wire message | Notes |
|---|---|---|
| `Message{role:"assistant"}` with text | `{"role":"assistant","content":"<text>"}` | `tool_calls` omitted (`skip_serializing_if = "Vec::is_empty"`, request.rs:141) |
| `FunctionCall{call_id,name,arguments}` | `{"role":"assistant","tool_calls":[{"id":"<call_id>","type":"function","function":{"name":"<name>","arguments":"<json string>"}}]}` | **`content` is absent** — `content: None` with `skip_serializing_if = "Option::is_none"` (request.rs:139-140, 348-368). `arguments` is the raw JSON string, replaced by `"{}"` if unparseable (request.rs:431-438). No `extra_content`, no signature of any kind. |
| `CustomToolCall` (apply_patch) | same shape, `arguments` = `{"input":"<patch>"}` | request.rs:369-386 |
| `FunctionCallOutput{call_id,output}` | `{"role":"tool","tool_call_id":"<call_id>","content":"<text>"}` | **No `name` field** (request.rs:144-146, 387-398). `content` is `output.body.to_text().unwrap_or_default()`, so an empty tool result is `""`. |
| `Reasoning{..}` | **dropped** | request.rs:399-403: "Thinking has no wire here … a replayed reasoning item would be a `400` at best." |

Then `merge_adjacent` (`request.rs:446-482`) collapses a text assistant message followed by a `FunctionCall` into **one** assistant message carrying both `content` and `tool_calls` — the OpenAI-canonical shape for the preamble-then-call pattern the screenshot shows. Parallel calls become one message with several `tool_calls`.

The `id` echoed back is whatever the stream's `tool_calls[].id` was; if the provider sent none it is synthesised as `call_{index}` (`sse.rs:500-502`). The stream parser reads only `index`, `id`, `function.name`, `function.arguments` from each tool-call delta (`sse.rs:137-156`) — any provider extension such as Gemini's `extra_content` is silently ignored.

`tools` is rebuilt from the Responses tool JSON every turn (`request.rs:488-533`): `{"type":"function","function":{"name","description","parameters"}}` with `parameters` copied through verbatim; Codex's `shell_command` schema carries `"additionalProperties": false` (`core/src/tools/handlers/shell_spec.rs:104-108`, `tools/src/json_schema.rs:59-63`) and the flattened `apply_patch` tool does too (`request.rs:541-557`). `tool_choice: "auto"` rides whenever there are tools (`request.rs:245`). `strict` is *not* forwarded (only name/description/parameters are copied). No `parallel_tool_calls`, no `reasoning_effort`.

### 3.2 What the providers document (MEASURED, from docs)

**Gemini 3 requires thought signatures on replayed function calls, and says so in 4xx terms.**

- Gemini API, thought signatures (https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures): "When using Gemini 3 models, you must pass back thought signatures during function calling, otherwise you will get a validation error (4xx status code). This includes when using the `minimal` thinking level setting for Gemini 3 Flash." — "Strict validation is enforced for all function calls within the current turn." — "The first `functionCall` part in each step of the current turn must include its `thought_signature`." — "If you omit a `thought_signature` for the first `functionCall` part in any step of the current turn, the request will fail with a 400 error." The error reads "Function call `<Function Call>` in the `<index of contents array>` content block is missing a `thought_signature`." A turn starts at "the most recent User message that contains standard content (e.g., `text`)", which "will not be a `functionResponse`" — so the replay in §3.1 (user text → assistant call → tool result) is exactly the "current turn" the validator inspects. Model matrix: "Gemini 3 will always have the signature on the first function call part. It is **mandatory** to return that part." versus Gemini 2.5, where "It is **optional**".
- Gemini 3 guide (https://ai.google.dev/gemini-api/docs/generate-content/gemini-3): "The API enforces strict validation on the 'Current Turn'. Missing signatures will result in a 400 error." and "Circulation of thought signatures is required even when thinking level is set to `minimal` for Gemini 3 Flash."
- **How it appears on the OpenAI-compatible wire** (same page, "Signatures for OpenAI compatibility"; OpenAI-compat guide https://ai.google.dev/gemini-api/docs/openai: "Gemini 3 supports OpenAI compatibility for thought signatures in chat completion APIs"): the signature rides *on each tool call* as `"extra_content": {"google": {"thought_signature": "<Signature A>"}}` inside `tool_calls[]`, beside `id`, `type` and `function`, and the client must send that object back in the replayed assistant message. In the parallel-call example only the first tool call carries `extra_content`. The doc's own replayed assistant message has **no `content` key** (only `role` + `tool_calls`), and its tool messages are `{"role":"tool","name":"check_flight","tool_call_id":"function-call-…","content":"{…}"}` with model-issued ids like `function-call-1d6a1a61-6f4f-4029-80ce-61586bd86da5`.
- **Vertex enforces the same rule** (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thought-signatures): "If a required thought signature is not returned when using Gemini 3 models, the model will return a 400 error." — "A turn begins with the most recent user message that is not a `functionResponse`." — same `extra_content.google.thought_signature` examples for the OpenAI-compatible endpoint. Streaming caveat: "When streaming, this signature might be returned in a part with empty text content, so be sure to parse all parts until `finish_reason` is returned by the model." Escape hatch: "You can set `thought_signature` to `skip_thought_signature_validator`, but, this should be a last resort as it will negatively impact model performance." (The Gemini API page names a second dummy, `context_engineering_is_the_way_to_go`.)
- Vertex's OpenAI-compatible parameter table (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/overview): `extra_content.google.thought_signature` — "A bytes field that provides a thought signature to validate against thoughts returned by the model"; Gemini-specific features "must be contained within an `extra_content` or `extra_body` or they will be ignored."

**Everything else the second turn carries is documented as acceptable.**

- Assistant message without `content`: OpenAI's spec (`openai/openai-openapi`, `manual_spec/openapi.yaml`) makes `content` "Required unless `tool_calls` or `function_call` is specified", `required: [role]` only; Google's own compat example omits it. Not a cause.
- Tool message without `name`: OpenAI requires `[role, content, tool_call_id]` only. Google's example *includes* `name`, but no doc says it is required on the compat surface. UNVERIFIED either way; low.
- Tool schemas: Vertex's table says `tools` takes `type, function, name, description, parameters` and "`parameters`: Specify parameters by using the OpenAPI specification. This differs from the OpenAI `parameters` field, which is described as a JSON Schema object." Gemini's native `Schema` is "a select subset of an OpenAPI 3.0 schema object" (https://ai.google.dev/api/generate-content#Schema) listing `type, format, title, description, nullable, enum, maxItems, minItems, properties, required, minProperties, maxProperties, minLength, maxLength, pattern, example, anyOf, propertyOrdering, default, items, minimum, maximum` — no `additionalProperties`, `oneOf`, `$schema`, `$ref`, `$defs`; the `default` note ("included here and ignored so that developers who send schemas with a default field don't get unknown-field errors") implies unknown keywords *can* error on the native surface. **But the identical `tools` array was accepted on turn 1**, which rules this out as the turn-2 trigger regardless of what the compat layer does with `additionalProperties`.
- Unsupported top-level parameters: Vertex — "If you pass any unsupported parameter, it is ignored." (`stream_options`, `parallel_tool_calls`, `strict` are absent from its supported list.) `tool_choice: auto` is supported. Would have failed on turn 1 too. Not a cause.
- Interleaving: "If you have them interleaved as 'FC1 + signature, FR1, FC2, FR2' the API will return a 400 error." The client's `merge_adjacent` emits one assistant message carrying every parallel call, then the tool messages — the accepted "FC1+signature, FC2, FR1, FR2" order. Not a cause for the single-call screenshot; worth keeping in mind for parallel calls once signatures are round-tripped.
- Cloudflare's compat endpoint documents nothing about field translation or error surfacing (https://developers.cloudflare.com/ai-gateway/usage/chat-completion/, https://developers.cloudflare.com/ai-gateway/usage/providers/vertex/); its troubleshooting page says only "Review AI Gateway logs for detailed error information." Whether the hop preserves `extra_content` in *either* direction is undocumented (§5.3).

### 3.3 Ranked root causes

1. **The replayed `tool_calls` entry has no `extra_content.google.thought_signature`, and Gemini 3.x on Vertex rejects the current-turn function call with a 400.** Evidence: both the Gemini API and Vertex docs say precisely this, for precisely this model generation, in precisely the turn structure the client sends (§3.2, MEASURED); the client neither reads `extra_content` from the stream (`ChatToolCallDelta`, sse.rs:137-148) nor has a place to carry it (`ToolCallOut`, request.rs:163-169; `Reasoning` items are dropped, request.rs:399-403) (§3.1, MEASURED); and turn 1 — which carries the same tools and no function-call history — succeeds, which is the signature of a history-only rejection (MEASURED from the report). It also explains why both catalogued Gemini rows (3.6 Flash, 3.5 Flash Lite — both Gemini 3.x) fail alike and why the pre-fork gateway-fit research flagged "reasoning replay absence on the gateway wire" as an open question (`docs/research/codex-atlas-gateway-fit.md`, Open questions 1-2). Predicted `error.upstream` text: "Function call `<name>` in the `<n>` content block is missing a `thought_signature`." One residual unknown: whether the Vertex-compat stream actually emits `extra_content` on the `delta.tool_calls` chunk (Vertex notes a signature "might be returned in a part with empty text content" when streaming), and whether Cloudflare's hop forwards it — if not, the only client-side remedy is the documented dummy signature.
2. **Synthesised `call_{index}` id.** If the compat stream sent no `tool_calls[].id`, the client invents one (sse.rs:500-502); Gemini's docs require "the exact `id` from the `function_call`" and Gemini 3 "always returns a unique `id`". Google's compat examples show ids present, so this only bites if Cloudflare or Vertex strips them on the stream. INFERRED; checkable from the `RUST_LOG=codex_api=trace` frames (§5.1). Its fix is subsumed by (1): carrying the call through faithfully.
3. **`role: "tool"` without `name`.** Google's compat example carries `name`; nothing says it is mandatory. UNVERIFIED, low; trivially cheap to add (the name is on the `FunctionCall` item the output is paired with).
4. **Schema keywords (`additionalProperties: false`, etc.)** — excluded by turn 1 succeeding with the same `tools` (§3.2). Listed because it is the usual suspect and would otherwise be re-investigated.
5. **Omitted `content`, `tool_choice`, `stream_options`, `response_format`, `max_tokens`** — all documented as accepted or ignored, and all present on the successful first turn. Not causes.

## 4. Failure 2 — GLM cannot be read

### 4.1 What the client expects of a chunk (MEASURED)

```rust
// sse.rs:107-156
struct ChatChunk    { id: Option<String>, #[serde(default)] choices: Vec<ChatChoice>, usage: Option<ChatUsage> }
struct ChatChoice   { #[serde(default)] delta: ChatDelta, finish_reason: Option<String> }
struct ChatDelta    { content: Option<String>, reasoning_content: Option<String>, #[serde(default)] tool_calls: Vec<ChatToolCallDelta> }
struct ChatToolCallDelta { index: u32, id: Option<String>, function: Option<ChatFunctionDelta> }
```

Exactly two fields are `Vec`s: `ChatChunk.choices` and `ChatDelta.tool_calls`. `#[serde(default)]` supplies a value when the key is **absent**; a key that is **present with `null`** goes through `Vec`'s deserializer and fails with `invalid type: null, expected a sequence`. The suite pins this: `an_explicit_null_where_a_default_is_declared_is_a_lost_frame_too` plays `{"id":"c1","choices":null}` and asserts an error (`sse_tests.rs:459-471`) — the comment says "`#[serde(default)]` covers a *missing* key, not a present-but-null one". Every `Option<…>` field (`content`, `reasoning_content`, `id`, `finish_reason`, `usage`, …) accepts `null` fine. The error string is built at sse.rs:333-336 and, because the frame's content is lost, the turn is deliberately failed at close rather than completed short (sse.rs:326-338, the `#59` rationale).

The catalogue's remark that "the engine reads no such field" for GLM's `reasoning_content` (`catalog.rs:64-66`) is stale — `ChatDelta.reasoning_content` is read and streamed as a reasoning item (sse.rs:131-132, 353-368). It is not the cause here, but the comment should not be trusted.

### 4.2 What "column 219" means (MEASURED)

Compiled and run against `serde_json 1.x` in a scratch crate (this session): for `{"id":"c1","choices":null}` (26 bytes, `null` at columns 22–25) the error is `… at line 1 column 25`; for a delta-level `"tool_calls":null` ending at column 64 the error is `… column 64`. **serde_json reports the column of the last byte of the `null` literal.** So in the GLM frame the `null` occupies bytes 216–219, and the key it belongs to ends at byte 214 (`":null` = 6 bytes).

### 4.3 Which field is at 219 (INFERRED)

Assuming the Workers AI chunk begins with OpenAI's field order — `{"id":"<id>","object":"chat.completion.chunk","created":<10 digits>,"model":"@cf/zai-org/glm-5.3-flash",…` — the `id` length that puts the first `null` at column 219 is:

| Chunk shape | `id` length needed |
|---|---|
| Usage-only final chunk, `"choices":null,"usage":{…}` | **106** |
| First chunk, `delta:{"role":"assistant","content":null,"tool_calls":null}` | 38 |
| First chunk, `delta:{"role":"assistant","content":"","tool_calls":null}` | 40 |
| Delta, `delta:{"content":null,"reasoning_content":"X","tool_calls":null}` | 33 |
| Delta, `delta:{"reasoning_content":"The user","tool_calls":null}` | 39 (computed this session: 244-byte frame, `null` ends at 219) |
| SGLang-style role chunk, `delta:{"role":"assistant","content":"","reasoning_content":null,"tool_calls":null}` | 15 |

Real ids are 36 (uuid4), 41 (`chatcmpl-` + 32 hex) or 45 (`chatcmpl-` + uuid) characters; a 106-character id is implausible even allowing ±30 bytes for a rewritten `model` string or a `system_fingerprint` field. **The position fits `choices[0].delta.tool_calls: null` on an early chunk — most likely the opening role/reasoning chunk of this reasoning model — and effectively rules out `choices: null` on the usage chunk.** It is a reconstruction; the capture in §5.2 settles it in one line.

### 4.4 What the providers document (MEASURED, from docs)

- **Cloudflare publishes no streaming chunk schema for this model.** The model page's raw schema (`src/content/workers-ai-models/glm-5.3-flash.json` in `cloudflare/cloudflare-docs`, which renders https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/) declares `schema.output` as a `oneOf` whose streaming branch is, in full, `{"type":"string","contentType":"text/event-stream","format":"binary"}`. The synchronous branch is a copy of OpenAI's object: `message.content` is `anyOf [string, null]`, `message.tool_calls` is `{"type":"array", …}` with **no null branch**, `message.function_call` *is* nullable. Properties: `function_calling: true`, `reasoning: true`, `vision: true`, `context_window: 1048576`. Input accepts `stream_options.include_usage` and `reasoning_effort` (`low|medium|high|null`, description copied from OpenAI's spec). The string `reasoning_content` does not occur in the file at all.
- **Workers AI's OpenAI-compatibility page** documents only the base URL and the two paths; nothing on chunk shape, `stream_options`, usage chunks or deviations (https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/). The function-calling page says nothing about streaming (https://developers.cloudflare.com/workers-ai/features/function-calling/).
- **AI Gateway compat endpoint**: lists `workers-ai/@cf/…` as a supported model form and says nothing about re-serialising streams (https://developers.cloudflare.com/ai-gateway/usage/chat-completion/, https://developers.cloudflare.com/ai-gateway/usage/rest-api/). Whether the compat hop rewrites Workers AI chunks is **undocumented**.
- **OpenAI's reference** (https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events): `choices` — "Can also be empty for the last chunk if you set `stream_options: {"include_usage": true}`" (an empty array, not `null`); `usage` — "contains a null value except for the last chunk"; delta `content` — string, optional, **nullable**; delta `tool_calls` — array, optional, **not nullable**. So the client's types are exactly OpenAI's contract, and the frame that broke them is off-contract.
- **Z.ai's own GLM API** — the vendor Workers AI is hosting — never shows a `null` array either. Its streaming guide's final chunk keeps a *populated* `choices` beside `usage`: `{"id":"1",…,"choices":[{"index":0,"finish_reason":"stop","delta":{"role":"assistant","content":""}}],"usage":{…}}` then `data: [DONE]` (https://docs.z.ai/guides/capabilities/streaming.md; mirror https://docs.bigmodel.cn/cn/guide/capabilities/streaming.md). Its chat-completion reference types `tool_calls` as `array` and `reasoning_content` as `string` (https://docs.z.ai/api-reference/llm/chat-completion.md); GLM-5.3-Flash "use[s] forced thinking and cannot be disabled" (https://docs.z.ai/guides/capabilities/thinking-mode.md). Note Z.ai's usage chunk shape (`choices` non-empty) is *also* a deviation from OpenAI that the client already tolerates, because a populated array parses.
- **Open-source OpenAI shims that emit `"tool_calls":null` exist** (UNVERIFIED as Workers AI's stack — source code, not docs): SGLang's `DeltaMessage` declares `tool_calls: Optional[List[ToolCall]] = None` and serialises chunks with `model_dump_json()` without `exclude_none`, so every chunk carries literal `"content":null,"reasoning_content":null,"tool_calls":null` for unset fields; vLLM uses `exclude_unset=True` and omits them. Both emit the usage chunk as `choices: []`. This is consistent with the column-219 arithmetic (§4.3) and is the most economical explanation of a `null` array on a model whose vendor API does not produce one — but which engine Cloudflare runs for `@cf/zai-org/glm-5.3-flash` is not documented anywhere.

### 4.5 Ranked root causes

1. **`choices[0].delta.tool_calls: null` emitted by Workers AI's serving stack, on the first (role/reasoning) chunk.** Evidence: column arithmetic (§4.3, INFERRED); OpenAI says the field is not nullable and Z.ai never emits it null, so the null is introduced by Cloudflare's shim (§4.4, MEASURED); a known OpenAI-compatible server emits exactly this (§4.4, UNVERIFIED for Cloudflare). The client fails on it by design (§4.1).
2. **`choices: null` on the usage-only final chunk.** Same client mechanism, but the position needs an implausible ~106-byte `id` (§4.3), and both OpenAI's spec and both open-source servers use `choices: []`. Ranked second only because Cloudflare documents nothing that excludes it — and because the client's own test (`sse_tests.rs:459`) shows the authors expected this one.
3. **A `null` somewhere the client does not read at all** — cannot be the cause: serde ignores unknown keys, and `null` in an `Option` field parses. Only the two `Vec`s can produce this error.

The gateway is **not** a suspect for GLM: it spreads the request unchanged and passes the bytes through (§2.1-2.2). The AI Gateway compat hop is the one undocumented place a rewrite could happen; the capture in §5.2 covers it.

## 5. What must be confirmed, and how

### 5.1 Gemini — capture the provider's 400 body

The gateway already has it (`error.upstream`, §2.3); the client throws it away. Three ways to see it, cheapest first:

1. **Rollout trace.** Set `CODEX_ROLLOUT_TRACE_ROOT=<dir>` in the app's environment (`vendor/codex/rollout-trace/src/thread.rs:44, 101-107`); `record_started(&built.request)` writes the exact request body of every attempt (`rollout-trace/src/inference.rs:174-194`; call at `core/src/client.rs:1494`), which shows the replayed assistant/tool messages verbatim — but the failed attempt stores only `error.to_string()`, i.e. the outer 502 sentence, so this confirms *what was sent*, not *why it was refused*.
2. **`RUST_LOG=codex_api=trace`** (`src-tauri/src/logging.rs:4-11`) shows every SSE frame of the successful first turn (`sse.rs:298`), including the tool-call deltas — useful to see whether Vertex's compat layer sends a `tool_calls[].id` at all and whether an `extra_content` block is present that the client is dropping.
3. **The gateway's own log row / a `curl` replay.** `x-atlas-request-id` and `x-atlas-gateway-log-id` are on the response (`gw:index.ts:768-771`); the Cloudflare AI Gateway log for that id holds the upstream body. Or replay the captured request body from (1) straight at the gateway with `curl` and read `error.upstream` from the 502.

Whichever route, the decisive string is Vertex's `error.message` for the second turn.

### 5.2 GLM — capture one raw frame

`RUST_LOG=codex_api=trace` logs each frame before the parse (`sse.rs:298`), and the parse failure with the serde message at `debug` (`sse.rs:324`). One "Hello" turn gives the offending line and settles §4.3 in seconds. Equivalent: `curl -N` the gateway with `{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Hello"}],"stream":true,"max_tokens":64}` and look at bytes 200–230 of the first frame.

### 5.3 Things this document could not verify

- Which inference engine Cloudflare runs `@cf/zai-org/glm-5.3-flash` on, and therefore whether the `null` is per-chunk (SGLang-style) or only on some chunks.
- Whether Cloudflare's compat hop rewrites Vertex's response (e.g. strips `extra_content`) — undocumented in both directions.
- Whether the Gemini failure reproduces on a model that is *not* Gemini 3.x (e.g. a 2.5 row, if one is priced) — a single-variable test of the thought-signature hypothesis.

## 6. Recommended fixes

### 6.1 Client, GLM — tolerate `null` where an array is expected (sse.rs)

Replace `#[serde(default)]` on the two `Vec` fields with a null-tolerant deserializer:

```rust
fn null_as_empty<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}
// ChatChunk:  #[serde(default, deserialize_with = "null_as_empty")] choices: Vec<ChatChoice>,
// ChatDelta:  #[serde(default, deserialize_with = "null_as_empty")] tool_calls: Vec<ChatToolCallDelta>,
```

`default` is still needed for the absent-key case; `deserialize_with` handles present-`null`. This changes the behaviour `an_explicit_null_where_a_default_is_declared_is_a_lost_frame_too` (`sse_tests.rs:459-471`) pins, and that test's rationale — "silent by construction otherwise" — no longer applies once `null` is *understood* rather than skipped: a `null` array carries no content, so nothing is lost by reading it as empty. Rewrite that test to assert the opposite (a `null` array is an empty array and the turn completes), and add a Workers-AI-shaped fixture with `"tool_calls":null` inside a `reasoning_content` delta. Keep the lost-frame rule for genuinely unparseable frames.

Also update the stale `catalog.rs:64-66` comment (the engine does read `reasoning_content`).

### 6.2 Client, diagnosis — surface `error.upstream` (atlas_gateway.rs)

Add `#[serde(default)] upstream: Option<serde_json::Value>` to `GatewayError` and, for `502 provider_error`, append a compact rendering of it to the `RetryCautiously` message (e.g. the upstream `error.message` / first `[].error.message` of Vertex's bare-array shape, capped). The gateway doc guarantees the field (§9 table). This is independent of either fix and makes the *next* provider failure self-diagnosing. Consider also not retrying a 502 whose `upstream` status is 4xx: a provider 400 is deterministic and five re-sends only add six seconds and five reservations (§2.3).

### 6.3 Client, Gemini — round-trip the thought signature (after §5.1 confirms it)

The docs-backed fix for cause 1 is to carry Gemini's per-call `extra_content` from the stream back into the replay, provider-agnostically (the field is simply absent on Claude and GLM):

1. **Read it.** Add `#[serde(default)] extra_content: Option<serde_json::Value>` to `ChatToolCallDelta` (sse.rs:137-148) and keep the *first non-null* one per `index` in `PartialToolCall` (sse.rs:208-213, 382-395) — Vertex says the signature may arrive on a later, otherwise-empty part.
2. **Store it.** `ResponseItem::FunctionCall` already has an `internal_chat_message_metadata_passthrough` slot (sse.rs:514-522); put the `extra_content` value there so it persists in the rollout with the call, and nothing else in the engine has to learn a new field.
3. **Send it back.** Add `#[serde(skip_serializing_if = "Option::is_none")] extra_content: Option<Value>` to `ToolCallOut` (request.rs:163-169) and populate it from the passthrough in `push_item` (request.rs:348-368). Do not attach it to the `CustomToolCall`/apply_patch arm unless it was received on that call; Gemini attaches the signature only to the first call of a parallel group and validates only that one.
4. **Fixtures.** A recorded Vertex-compat frame carrying `extra_content` (from §5.1's capture) in `sse_tests.rs`, and a `request_tests.rs` case asserting the value survives to the wire byte-for-byte.
5. **Fallback, and only if the capture shows the stream never carries a signature** (Cloudflare stripping it, or Vertex not emitting it on compat): send `extra_content.google.thought_signature = "skip_thought_signature_validator"` on the first tool call of each assistant message when the model slug starts with `gemini`. Google documents this as "a last resort" that "will negatively impact model performance", so it should be a stopgap with an issue attached, not the design.

Two cheap companions regardless of the capture: forward the tool's `name` on `role: "tool"` messages (cause 3 — the name is on the paired `FunctionCall`, one field in `push_item`), and never invent `call_{index}` on a stream that gave no id *when the provider is one that validates ids* (cause 2) — though if (1)-(3) land the id is whatever Gemini issued and this becomes moot.

Do **not** start with the assistant `content` key (cause 5) or with tool-schema sanitisation (cause 4): both are documented as accepted and both are present on the turn that succeeds.

### 6.4 Gateway

- **Nothing is required for GLM** if 6.1 lands — but a defensive normaliser on the Workers AI path (`null` array → `[]`) would protect every other OpenAI-strict client the gateway serves, at the cost of a per-frame JSON parse that the pass-through design (§2.2) deliberately avoids. The gateway's own contract says frames are OpenAI-shaped; today they are not, on this row.
- For Gemini, if the cause is a provider-specific field the compat layer needs echoed, the gateway is the *wrong* place to fix it (it would have to keep per-call state across stateless turns); the client owns the replay.

## 7. Sources

**This repo (client)**
- `vendor/codex/codex-api/src/atlas_chat/request.rs` — request builder; `ChatMessage` 131-152, `ToolCallOut` 163-169, `build_chat_request` 203-253, `push_item` 317-412, `valid_json_arguments` 431-438, `merge_adjacent` 446-482, `reshape_tools` 488-533, `flatten_freeform` 541-557.
- `vendor/codex/codex-api/src/atlas_chat/sse.rs` — chunk structs 107-180, parse and lost-frame rule 321-339, tool-call assembly 382-395 / 495-523.
- `vendor/codex/codex-api/src/atlas_chat/sse_tests.rs:428-471` — lost-frame and explicit-`null` tests.
- `vendor/codex/codex-api/src/atlas_gateway.rs` — `GatewayError` 63-86, `classify` 143-197, `into_api_error` 251-273.
- `vendor/codex/codex-api/src/api_bridge.rs:20-32`; `vendor/codex/protocol/src/error.rs:92, 362-397`.
- `vendor/codex/model-provider/src/provider.rs:302-346`; `vendor/codex/model-provider-info/src/lib.rs:27-31, 333-336`; `vendor/codex/core/src/session/turn.rs:1347-1420`; `vendor/codex/core/src/client.rs:1445-1560`.
- `vendor/codex/core/src/tools/handlers/shell_spec.rs:100-110`; `vendor/codex/tools/src/json_schema.rs:39-74, 153-166`.
- `vendor/codex/rollout-trace/src/thread.rs:44, 101-107`; `vendor/codex/rollout-trace/src/inference.rs:174-194, 239-262`.
- `crates/atlas-native-agent/src/engine/catalog.rs:57-66, 100-121`; `src-tauri/src/logging.rs:4-11`.
- `docs/reference/atlas-ai-api.md` — the gateway contract as vendored here; `docs/research/codex-atlas-gateway-fit.md` — prior fit analysis (Open question 1 there anticipated the reasoning-replay gap).

**`~/Codes/atlas-server-ref` @ `a619e33` (gateway)**
- `apps/ai/src/gateway.ts:57-115, 165-194, 278-361`; `apps/ai/src/broker.ts:61-115, 191-211`; `apps/ai/src/index.ts:710-866`; `apps/ai/src/metering.ts:295-339`; `apps/ai/src/errors.ts:34-64`.
- `packages/contracts/src/ai.ts:48-86` (`LooseObject`, `ChatCompletionRequest`).
- `apps/ai/test/workers-ai.test.ts:95-160`; commits `4ae40bd`, `a619e33`.
- `docs/api/atlas-ai-api.md` §4.3a, §5, §9.

**Primary sources — GLM / Workers AI / OpenAI**
- https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/ (raw schema: `src/content/workers-ai-models/glm-5.3-flash.json` in github.com/cloudflare/cloudflare-docs, branch `production`)
- https://developers.cloudflare.com/changelog/post/2026-08-26-glm-5.3-flash-workers-ai/
- https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- https://developers.cloudflare.com/workers-ai/features/function-calling/
- https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
- https://developers.cloudflare.com/ai-gateway/usage/rest-api/
- https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events (the same reference as https://platform.openai.com/docs/api-reference/chat/streaming, which refused the fetcher)
- https://docs.z.ai/guides/capabilities/streaming.md · https://docs.bigmodel.cn/cn/guide/capabilities/streaming.md
- https://docs.z.ai/guides/capabilities/stream-tool.md · https://docs.z.ai/api-reference/llm/chat-completion.md · https://docs.z.ai/guides/capabilities/thinking-mode.md · https://docs.z.ai/guides/vlm/glm-5.3-flash.md
- (non-doc, UNVERIFIED for Cloudflare) SGLang `python/sglang/srt/entrypoints/openai/protocol.py` `DeltaMessage`; vLLM `vllm/entrypoints/openai/protocol.py` `DeltaMessage` and `serving_chat.py` `model_dump_json(exclude_unset=True)`.

**Primary sources — Gemini / Vertex / OpenAI**
- https://ai.google.dev/gemini-api/docs/openai — OpenAI compatibility ("Gemini 3 supports OpenAI compatibility for thought signatures in chat completion APIs"; "Support for the OpenAI libraries is still in beta")
- https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures — the 400 rule, current-turn definition, parallel-call rule, `extra_content.google.thought_signature` on the OpenAI wire, dummy signatures (`/docs/thought-signatures` now redirects elsewhere; this is the URL that serves the function-calling rules)
- https://ai.google.dev/gemini-api/docs/generate-content/gemini-3 — "strict validation on the 'Current Turn'"; required even at `minimal` thinking on Gemini 3 Flash
- https://ai.google.dev/gemini-api/docs/generate-content/function-calling — "select subset of the OpenAPI schema format"
- https://ai.google.dev/api/generate-content#Schema — the supported `Schema` field list and the `default` note
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output — supported keywords for structured output ("The model ignores unsupported properties")
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/overview — Vertex OpenAI-compatible parameter table; "If you pass any unsupported parameter, it is ignored"; `extra_content.google.thought_signature`
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai — endpoint and `google/gemini-…` model ids
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thought-signatures — Vertex's thought-signature rules, streaming caveat, `skip_thought_signature_validator`
- https://developers.cloudflare.com/ai-gateway/usage/providers/vertex/ — `google-vertex-ai/google/…` model form; regional-vs-`global` note
- https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/ — "Review AI Gateway logs for detailed error information"
- https://raw.githubusercontent.com/openai/openai-openapi/manual_spec/openapi.yaml — the spec behind https://platform.openai.com/docs/api-reference/chat (assistant `content` "Required unless `tool_calls` or `function_call` is specified"; tool message `required: [role, content, tool_call_id]`; `ChatCompletionMessageToolCallChunk`; `include_usage` → "`choices` field will always be an empty array")

Vertex's REST reference page for `chat.completions` returned 404 on every path tried on 2026-09-08; `platform.openai.com` refuses non-browser fetches, hence the spec-repo and `developers.openai.com` mirrors above.
