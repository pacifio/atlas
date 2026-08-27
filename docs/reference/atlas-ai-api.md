# Atlas AI API

API reference and integration guide for the **AI broker** (`apps/ai`, worker `atlas-ai`) —
the OpenAI-compatible surface Atlas serves in front of Google Vertex.

- **Audience:** engineers wiring the **desktop app** (Tauri, separate repo), the **web app**
  (`apps/web`), and anyone pointing an OpenAI SDK at Atlas.
- **Source of truth:** `apps/ai/src/`, `packages/contracts/src/ai.ts`, `packages/auth-client`.
- **Design context:** [ADR-0003](../adr/0003-embeddings-and-vectorize.md) (gateway + Vertex),
  [ADR-0005](../adr/0005-auth-model.md) (auth model),
  [ADR-0008](../adr/0008-ai-spend-controls.md) (spend controls),
  and the measured platform behaviour in
  [`docs/research/atl-73-gateway-cost-accuracy.md`](../research/atl-73-gateway-cost-accuracy.md).
- **Auth mechanics** (how to obtain a token at all) live in
  [`atlas-auth-api.md`](./atlas-auth-api.md). This doc assumes you already have one.

> **Shipped vs planned.** This surface is being built in slices. Everything in §4–§10 is
> **live**. §11 documents endpoints and failures that are **specified and reserved but not yet
> built** — they are here so clients can be written against the final contract rather than
> retrofitted. Every such row is marked **`PLANNED`** with its ticket. Nothing marked
> `PLANNED` will answer today.

---

## 1. Architecture at a glance

```
  Desktop / any OpenAI SDK                    Browser (web app)
  ── Bearer JWT ──────────────┐               ── cookie session ──┐
                              │                                   │
                              ▼                                   ▼
              https://ai.tryatlas.cc/v1                    web worker
                              │                                   │
                              │        ◄── AISVC service bind ────┘
                              ▼            (web mints + attaches the JWT)
                    ┌───────────────────────────┐
                    │  atlas-ai                 │  verify JWT (JWKS, local)
                    │  ONE handler, both doors  │  allowlist + clamp + translate
                    └─────────────┬─────────────┘  stamp 4 metadata entries
                                  │
                                  ▼                     D1 `atlas-auth`
                    ┌───────────────────────────┐       prices · grants ·
                    │  cap gate: reserve first, │  ◄──► counters · reservations
                    │  settle after             │       usage ledger
                    └─────────────┬─────────────┘              ▲
                                  │                            │ batched insert
                                  ├──► queue `atlas-ai-usage` ─┘
                                  │    (served, refused, errored, embedded)
                                  │
                                  │    cron 03:17 UTC ──► roll · prune · sweep
                                  │
                                  ▼  cf-aig-authorization
                    Cloudflare AI Gateway `atlas`   ← spend + rate backstop (R1/R2/R4)
                                  │  BYOK from secret store
                                  ▼
                        Google Vertex AI
```

**Two doors, one authorisation path.** A request arrives either on the public hostname or
over the `AISVC` service binding, and **both verify the same JWT with the same code**. No
caller may assert identity in a header — `X-Atlas-User` and friends are never read, on
either door. The binding is not spoofable, but the public route is, and a trusted-header
design would rest on a negative property (*"never honour this header unless it arrived via
the binding"*) that has to survive every future routing edit **on the worker that spends
money**. Verifying both makes the spoof unrepresentable.

**`atlas-ai` is the only broker.** The gateway credential (`CF_AIG_TOKEN`) never leaves the
worker, and no client ever talks to the AI Gateway or to Vertex directly.

**`atlas-ai` is stateless.** It is not, and will never be, the source of truth for
conversation history — the client sends its own `messages` every time. Each tool-call round
is therefore an ordinary separate request.

---

## 2. Base URLs & surfaces

| Surface | Base URL | Used by |
| --- | --- | --- |
| AI (direct) | `https://ai.tryatlas.cc/v1` | Desktop, any OpenAI SDK |
| AI (via web) | `https://app.tryatlas.cc/api/ai` → `/v1/*` | Browser (same-origin, cookie session) |

Throughout this doc, `{AI}` = `https://ai.tryatlas.cc/v1`.

The path `/v1/chat/completions` is **forced** — SDKs append it to `baseURL`, so `baseURL`
must end at `/v1` and no further.

---

## 3. Conventions

### 3.1 Authentication

| Header | Required | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <jwt>` | **yes** | Atlas access JWT, audience `atlas`. Same token as `ingest`/`sync`. |
| `Atlas-Org: <org_id>` | no | Declares the **paying org**. Must be covered by the token's `orgs` claim. |

`Atlas-Org` is optional. Omit it and the request is attributed to the caller personally
(the `org_none` sentinel). Send one the token does not cover and the request is refused
`403 org_not_covered` — the org is never inferred, because the payer is a billing decision.

`JWT_AUDIENCE` is `"atlas"`, deliberately shared with `ingest` and `sync`. A distinct
audience would scope a leaked AI token away from artifact writes, but costs desktop two
tokens on two refresh schedules and a "which token for which host" bug class in every
client — while the actual AI gate is the entitlement, not the audience.

**Auth is an admission decision.** It is verified once at request start and never re-checked
mid-stream. SSE has no mid-response re-auth, so a mid-stream 401 would reach the client as a
truncated stream anyway.

### 3.2 Identity headers are ignored

Any `X-Atlas-User`, `X-Atlas-Org` or `X-Atlas-Role` a caller attaches is **not read**, on
either door, and is not forwarded upstream. Identity comes from the verified token and
nowhere else.

### 3.3 Error shape

OpenAI's envelope throughout, so a stock SDK surfaces `err.status`, `err.code` and
`err.param` without knowing anything about Atlas:

```jsonc
{
  "error": {
    "message": "Unsupported parameter: 'thinking_budget'. …",
    "type": "invalid_request_error",   // OpenAI's vocabulary; group on this
    "code": "unknown_parameter",       // Atlas's machine-readable detail; branch on this
    "param": "thinking_budget",        // the offending field, or null
    "upstream": { }                    // 502 only: the provider's own error body
  }
}
```

On a `402` the envelope carries the quota detail alongside the standard fields:

```jsonc
{
  "error": {
    "message": "The org monthly AI budget is spent.",
    "type": "insufficient_quota",
    "code": "cap_exceeded",
    "param": null,
    "window": "monthly",              // or "daily" — which ceiling tripped
    "scope": "org",                   // "org" | "personal" | "member"
    "used": 307425,                   // SETTLED weighted tokens, matching GET /usage
    "cap": 350000,
    "reset": "2026-09-01T00:00:00.000Z"   // UTC, when `window` rolls over
  }
}
```

`used` is **settled** spend, deliberately excluding in-flight reservations — the same
number `GET {AI}/usage` returns, so the two can never be seen to disagree.

`type` follows OpenAI: `authentication_error` (401), `insufficient_quota` (402),
`permission_error` (403), `rate_limit_error` (429), `server_error` (5xx),
`invalid_request_error` (everything else).

**Branch on `code`, not on `message`.** Messages are diagnostic and will change.

### 3.4 Ordering of checks

Guards run in a fixed order, and it is observable:

1. Route match → `404 not_found`
2. Method → `405 method_not_allowed`
3. **Authentication** → `401`
4. Payer coverage → `403 org_not_covered`
5. Feature segment → `404 unknown_feature`
6. Body byte ceiling → `413 request_too_large`
7. Parse + allowlist → `400`
8. Prompt token ceiling → `413 prompt_too_large`
9. **Entitlement** → `403 no_entitlement`
10. Model catalogue → `403 model_not_allowed`
11. **Reservation against the cap** → `402 cap_exceeded`
12. Upstream call

Steps 9–11 are the only ones that cost a database round trip, which is why the free local
ceilings run first. The reservation is deliberately last: it is the final thing between a
caller and money being spent, and it is taken **before** the provider is called, never
after — see §4.4.

Authentication precedes body parsing, so **an unauthenticated caller sending a malformed
body gets `401`, not `400`** — and learns nothing about which parameters exist.

Every refusal from steps 6 and 8–11, plus a requests-per-minute refusal, is recorded as a
coalesced denial row (§10.2). Step 7 is not: a `400` is a client bug rather than a policy
decision.

---

## 4. `POST {AI}/chat/completions`

The raw surface. OpenAI's chat-completions dialect.

```http
POST https://ai.tryatlas.cc/v1/chat/completions
Authorization: Bearer <jwt>
Atlas-Org: org_01H…
Content-Type: application/json

{ "model": "gemini-3.6-flash", "messages": [ … ], "stream": true }
```

**Success** — `200`, the provider's response body verbatim (JSON, or `text/event-stream`
when `stream: true`), plus:

| Response header | Meaning |
| --- | --- |
| `x-atlas-request-id` | Our request id (ULID). Quote it in any support conversation. |
| `x-atlas-gateway-log-id` | The gateway's log id, when it returned one. |

### 4.1 Parameters

**Forwarded unchanged:** `messages`, `stream`, `temperature`, `top_p`, `stop`, `seed`,
`response_format`, `tools`, `tool_choice`, `presence_penalty`, `frequency_penalty`.

> **On Claude models, six of those are refused with `400 invalid_parameter`** —
> `temperature`, `top_p`, `seed`, `presence_penalty`, `frequency_penalty` and
> `response_format`. Vertex rejects the first two outright for the Opus models
> (*"`temperature` is deprecated for this model"*) and the Messages API has nowhere to put
> the rest. Refusing here rather than dropping them keeps the blame in the right place: a
> `400` naming the parameter, raised before any reservation, instead of a `502` from the
> provider after one. See §4.3a.

**Overridden by the server:**

| Parameter | What happens | Why |
| --- | --- | --- |
| `model` | Rewritten to `google-vertex-ai/<publisher>/<id>` on the compat endpoint; moved into the URL on Claude's (§4.3a) | A **double** prefix: the gateway's compat endpoint strips the provider segment, and Vertex then demands its own publisher segment. The single-prefix form the docs show is rejected upstream. The publisher is read off the model's price row, never assumed (§4.3) — a model whose row does not name one is refused rather than sent to Google. The response and the gateway log each spell the model differently again, so the server owns normalisation. |
| `max_tokens` | Clamped to **32,768**; injected as **4,096** when absent | Treated as a *reasoning-inclusive worst case*, not a bound on visible output — a `max_tokens: 8` call was measured returning zero content with the entire budget spent on reasoning. |
| `stream_options.include_usage` | **Forced `true`** on streamed calls, not client-overridable | Leaving it to the caller means a client that omits it is metered by estimate forever. That is an exploit, not an edge case. |

**Rejected — `400`, never a silent drop:** `n`, `user`, and **anything not on the forwarded
list**, including **nested** unknown keys such as `stream_options.thinking_budget`.

> Silently dropping is the failure this rule exists to prevent: a caller sets a
> thinking-budget parameter, is billed for behaviour they did not receive, and gets no
> signal at all.

### 4.2 Ceilings

| Ceiling | Value | Enforcement |
| --- | --- | --- |
| Request body | **2 MB** | Byte count **before parsing** — no tokenizer, no provider round-trip. |
| Prompt | **200,000 tokens** | Pre-flight, `413`. Estimated as `ceil(utf8_bytes / 3)` over **every prompt-bearing field** — `messages`, `tools`, `tool_choice`, `response_format`, `stop`. A tool schema is prompt. |
| Output | default 4,096, max 32,768 | `max_tokens` clamped server-side. |

The `/3` divisor is deliberately tighter than the ≈4 chars/token rule of thumb: no Gemini
tokenizer exists in a Worker, the errors are asymmetric (under-estimating costs real credit,
over-estimating costs a refusal we can explain), and source code tokenizes far worse than
the English prose those heuristics are calibrated on.

### 4.3 Model catalogue

| Model | Publisher | Notes |
| --- | --- | --- |
| `gemini-3.6-flash` | `google` | The default. Atlas follows the *latest* Gemini Flash rather than pinning a version. |
| `gemini-3.5-flash-lite` | `google` | The cheap tier — roughly a fifth of Flash on input. |
| `claude-opus-5` | `anthropic` | Partner model on Vertex, and the most expensive thing we resell. Served over Anthropic's own endpoint (§4.3a). |
| `claude-opus-4-8` | `anthropic` | Partner model on Vertex, priced identically to Opus 5. Same endpoint (§4.3a). |
| `claude-sonnet-4-6` | `anthropic` | The mid-tier Claude, ~40% of Opus on input. Same endpoint (§4.3a). |
| `deepseek-v3-2` | — | **Withdrawn** (ATL-173). Same `404`, no grant expected, so migration 0016 writes a newer row with **no publisher**: unroutable, out of the catalogue, refused `403 model_not_allowed` before any spend — while the priced 0014 row still costs the usage recorded against it. Restoring it is one price-console row naming `deepseek-ai` again. |

A model is selectable **if and only if** a price row is effective for it at the request's
date and that row is *routable* — completely priced, and naming the publisher that serves
it (ATL-136, extended by ATL-149). There is no separate allowlist to fall out of sync
with — which is the point: a second list can disagree with the price table, and the
disagreement shows up as a customer being offered a model the meter then refuses.

**Vertex is one provider carrying many publishers, and the publisher is stored per model
(ATL-149).** The outbound id is `<provider>/<publisher>/<model>` — so Claude is addressed
to `anthropic` and DeepSeek to `deepseek-ai`, not to `google`. A price row with **no**
publisher is not routable: it is left out of the catalogue and refused with the same
`403 model_not_allowed` as any unpriced model, rather than being guessed at. A guess would
produce a well-formed model id that only fails at Vertex, on a customer's request, after
the reservation has already been taken.

**A bigger model raises the smallest workable tier.** Reservation size scales with price,
so a maximum-size request against `claude-opus-5` reserves ~6.67M weighted tokens (~$2.00
at the peg) against ~1.8M (~$0.55) for Flash — meaning a tier needs roughly $3 of monthly
budget, after the 1.5x safety margin, before it can serve one Opus request at all. The
admin console warns about this when a cap is edited (ATL-148); a cap below the line does
not degrade gracefully, it makes large prompts permanently impossible while small ones keep
working.

**Adding a model widens every tier that has not narrowed itself.** A tier whose
`allowed_models` is NULL inherits the priced catalogue by design, so an existing grant on
such a tier can select a newly added model the moment its price row lands. The **cap does
not move** — it is denominated in weighted tokens and bounds total spend regardless of
model — but a customer can exhaust it roughly eighteen times faster on Opus than on Flash.
Narrow the tier's `allowed_models` first if that is not wanted.

> **Proven on the wire, and not uniformly (measured 2026-08-18, ATL-172).** ATL-149 shipped
> four ids that had never been sent to Vertex. Three of the five now have: `gemini-3.6-flash`
> and `gemini-3.5-flash-lite` serve on the compat endpoint, and `claude-opus-5` (with
> `claude-opus-4-8`, added here) serves on Anthropic's endpoint at `locations/global`.
> Two of the five needed a Vertex Model Garden grant before they would serve at all, and
> only one got it (ATL-173). `claude-sonnet-4-6` was granted and now generates on the same
> publisher path as the Opus models, buffered and streamed — no deploy was needed, because
> the price row already named its publisher. `deepseek-v3-2` was not, and is **withdrawn**:
> migration 0016 writes a newer row with no publisher, which takes it out of the catalogue
> and refuses it `403 model_not_allowed` before any spend. **A withdrawal is never a
> delete** — the priced row stays, so the nightly rollup can still cost a request that
> really happened, and only "can we address a request to it today" flips to false.

**An unknown or unpriced model is refused with `403 model_not_allowed`, before any provider
call.** It is never admitted at a default or punitive weight: a punitive weight still lets
the request through and makes its recorded cost fiction. `403` rather than `400` because
the same request succeeds for a caller whose grant covers the model — this is
authorization, not malformed input.

Pricing a new model is the whole of adding it. Insert a correct row and it appears in
`GET /v1/models` automatically; there is no approval queue.

The caller's grant may narrow it further: the effective set is
`(grant override ?? tier list) ∩ catalogue`. An override may *add* a model the tier lacks —
that is what overrides are for — but the intersection means it can never reach outside the
priced catalogue, so no per-customer edit routes around the fail-closed rule.

### 4.3a Claude on Vertex speaks Anthropic's dialect (ATL-172)

Everything above describes one wire: the gateway's OpenAI-compatible endpoint. **Claude is
not on it.** Measured against gateway `atlas` on 2026-08-18:

| Call | Result |
| --- | --- |
| `compat/chat/completions`, model `google-vertex-ai/anthropic/claude-opus-5` | `400 FAILED_PRECONDITION` — *"Publisher Model …/publishers/anthropic/models/claude-opus-5 is not servable in region global."* |
| Vertex's own `…/locations/global/endpoints/openapi/chat/completions` | Identical refusal — so the limit is Vertex's OpenAI surface, not the gateway |
| The same model on `…/locations/us-east5/…` | `429 Quota exceeded … online_prediction_input_tokens_per_minute_per_base_model` — this project holds no regional quota |
| `…/locations/global/publishers/anthropic/models/claude-opus-5:rawPredict` | `200`, a real generation. `:streamRawPredict` streams normally |

So a Claude request is addressed to `:rawPredict` (or `:streamRawPredict`) and carries
Anthropic's Messages body, through the **same gateway hop** as everything else — the BYOK
credential, the log row, the request metadata and every spend backstop are on that hop, and
a second door that skipped them would be a second set of ceilings to keep in step.

**Nothing about this is visible to a caller.** The request goes out as OpenAI, comes back as
OpenAI, and the meter, the ledger and the cap see one shape. The translation is
`apps/ai/src/anthropic.ts` and it is the only file that knows the difference.

| Direction | Translation |
| --- | --- |
| `messages` → Messages API | System messages become the top-level `system` (concatenated in order — Anthropic has one, OpenAI allows many). `role: "tool"` messages become `tool_result` blocks inside a single user turn. `tool_calls` become `tool_use` blocks; invalid JSON arguments are a `400` rather than a silently emptied call. `image_url` parts become `image` blocks, `data:` URIs decoded to a base64 source. |
| `tools` / `tool_choice` | `function.parameters` → `input_schema`; `auto` → `{type:"auto"}`, `required` → `{type:"any"}`, `none` → `{type:"none"}`, a named function → `{type:"tool"}`. |
| `stop` | `stop_sequences`. `max_tokens` arrives already clamped. `model` is **not** sent in the body — a stray one is `400 "Extra inputs are not permitted"` at Vertex. |
| Reply → chat completion | `text` blocks join into `content`; `thinking` blocks become **`reasoning_content`**, kept out of `content` so a client that ignores it still sees only the answer; `tool_use` blocks become `tool_calls`; `stop_reason` maps to `finish_reason` (`max_tokens` → `length`, `tool_use` → `tool_calls`, `refusal` → `content_filter`, everything else → `stop`). |
| Streamed reply | Anthropic's event stream is rewritten frame-by-frame into `chat.completion.chunk`s — never buffered — ending with the usage-only chunk `stream_options.include_usage` produces on the OpenAI side, then `data: [DONE]`. A mid-stream `error` event is surfaced by the same `502`-frame-and-withhold-`[DONE]` path as any other provider failure (§5). |

**`usage` is the mapping that moves money.** Anthropic reports `input_tokens` *excluding*
cache reads and cache writes, where OpenAI's `prompt_tokens` is the whole prompt with
`prompt_tokens_details.cached_tokens` as a subset of it. Atlas therefore sends
`prompt_tokens = input + cache_read + cache_write`, `cached_tokens = cache_read`, and
computes `total_tokens` itself — the meter derives output as `total − prompt` and never
reads `completion_tokens`. Claude's `output_tokens` already includes thinking tokens
(measured: `output_tokens: 86` with `thinking_tokens: 60`), so reasoning is charged without
a special case. A `usage` block missing either count is reported as **no usage at all**
rather than as zero — a fabricated zero would read downstream as a measurement and settle
the request at nothing, where no usage falls back to the (pessimistic) reservation.

> **Known under-charge: a cache *write* is billed as plain input.** Anthropic prices a
> 5-minute cache write at 1.25x base input; the price table has one cached rate (the 0.1x
> read) rather than a third column, so writes are under-charged by 25% of the tokens
> written. The available alternative — charging writes at the *read* rate — is ten times
> worse in the same direction. The 10% endpoint premium already carried on both Claude
> price rows cushions it. A third rate column is the real fix and belongs with
> reconciliation (ATL-147), once there is data on how often callers cache at all.

> **The gateway prices a Claude request at zero, and that is measured.** The log row for a
> real `claude-opus-4-8` call carries `tokens_in: 14, tokens_out: 4, cost: 0` — the gateway
> counts the tokens but has no rate for Vertex's partner models. Two consequences, both
> already predicted by ADR-0008 decision 4: the gateway's **dollar** backstops (R1–R3) can
> never trip on Claude, leaving the request-rate rule (R4) as the only gateway-side
> ceiling; and nightly reconciliation (ATL-147) will read a 100% divergence on every Claude
> row rather than the small one it is written to alarm on. Neither weakens the primary
> control: per-org enforcement is our own weighted ledger, which prices Claude from
> `ai_model_price` and does not consult the gateway at all.

**Sampling parameters are refused on these models** (§4.1): Vertex rejects `temperature` and
`top_p` for both Opus releases — *"`temperature` is deprecated for this model"* — and
`seed`, `presence_penalty`, `frequency_penalty` and `response_format` have no Messages API
counterpart. The refusal is a `400 invalid_parameter` naming the parameter, raised **before**
the reservation, so a request that could never have been sent never holds room.

### 4.4 The cap, and why it is reserved before the call

Caps are denominated in **weighted tokens**, never in an estimated dollar figure. A weight
is a line item's price divided by a frozen `$0.30 / 1M` peg; a tier's dollar budget becomes
the enforced number once, at read time, divided by that peg and a deploy-gated safety
margin.

**The charge is reserved before the provider is called, then settled after.** The obvious
alternative — check the cap, call, then charge — was prototyped and measured **overshooting
a cap by 200% at twenty concurrent requests**, because every concurrent caller gates against
the same pre-call figure. The overshoot scales with *client* concurrency, which Atlas does
not control.

The reservation is deliberately conservative and this is visible to callers: input is
estimated from raw byte length, output is reserved at the **full clamped `max_tokens`
treated as reasoning-inclusive**, and **no cache hit is assumed**. A request can therefore
be refused with `402` while its actual cost would have fitted. Over-reserving costs a
refusal we can explain; under-reserving costs real credit.

**What is *charged*, though, is the provider's own count, not the reservation.** The
settle reads the reply's `usage` block and converts it with the same weighted formula:

```
weighted = (input − cached − audio) × w_in
         + cached × w_cached
         + audio  × w_audio
         + (total − input) × w_out
```

Two details of that line carry measurement behind them. **Output is `total_tokens −
prompt_tokens`, and `completion_tokens` is never read** — a reply cut off mid-reasoning
omits `completion_tokens` entirely while still reporting a correct total, measured
under-billing by 13–26× (ATL-73 §1.9). And **`cached` is priced at the cached weight**, so
a cache hit is a real discount to the caller rather than a rounding we keep.

When the reply carries no usable `usage`, what happens depends on *how it ended*:

| Ending | Charged | Why |
| --- | --- | --- |
| Ended cleanly, no `usage` | the **reservation** | `include_usage` is forced on precisely so this cannot be opted out of. Charging a cheap estimate here would make silence the cheapest way to be metered — an exploit, not an edge case. |
| **Aborted** — caller hung up, or the provider dropped | the prompt **plus an estimate from the bytes actually delivered** | Generation stopped, so credit stopped burning. Paying the provider to finish an answer nobody will read, only to learn its exact cost, buys precision we do not need. |

The byte→token conversion is the same `ceil(utf8_bytes / 3)` the reservation's input estimate
uses, so the measured and estimated paths cannot drift apart. It counts the SSE framing along
with the content, which overstates slightly — the direction to overstate in.

The abort case does under-charge one shape: a generation that spent its budget on reasoning
it never emitted. That is the accepted price of not burning credit on an abandoned answer.

**The cap therefore binds admission, not the last request's final cost.** A request is
admitted against the estimate and charged against the truth, and the truth can exceed the
estimate — the byte-derived input count is not a tokenizer. So settled spend can pass the
cap by at most the overshoot of a *single* request, after which every subsequent one is
refused. What the cap rules out is the unbounded, concurrency-scaled overshoot §4.4 opens
with; it was never a promise that the last request would be truncated mid-flight.

**A stream already in flight is never interrupted by a cap.** The gate is an admission
decision, checked once at request start — those tokens are already burned, and there is no
mid-stream re-check to fail.

### 4.5 Rate and concurrency limits

Two mechanisms — an exact concurrency bound and an approximate rate limit — because the two
failure shapes differ. **Both answer `429` with `Retry-After`** — deliberately the opposite
choice from the cap (§9.1), and for the mirrored reason: these clear in seconds, so a stock
SDK's automatic backoff is exactly the right behaviour.

| Bound | Limit | How exact |
| --- | --- | --- |
| Concurrent requests, one member within one payer | **4** | **Exact.** Open reservations *are* the in-flight requests, and the bound is two more clauses on the gate's existing conditional insert — serialised by D1's single writer, no extra round trip, no new state. |
| Concurrent requests, one payer in total | **20** | Exact, same statement. Stops one organisation's members summing to unbounded parallel generations. |
| Requests per minute, per caller | **60** | **Approximate.** The platform limiter is documented as permissive, eventually consistent, and counted independently per location. |

Concurrency is the control that matters — a runaway agent's damage is parallel long calls,
not request frequency. The approximate limiter is acceptable *for what it catches*: one
runaway client on one connection reaches one location, so there the per-location counter is
the global one, and it costs no database write on the hot path.

The rate limit is keyed on the **token subject** and applies to every authenticated route,
including `GET {AI}/models` and `GET {AI}/usage` — a loop polling those is the same client
doing the same damage. Per-member concurrency is counted *within a payer*, so a user who
belongs to two organisations has four slots in each.

**When a caller is both out of slots and out of budget, the answer is the `402`.** Telling
them to retry in a second would be a lie their SDK would act on; the cap is the durable
truth, so it wins.

**A `402` is only returned when *settled* spend is what overflows the cap.** Admission is
decided on settled spend plus everything in flight (§4.4), and that second part is an
estimate that a settle can hand straight back — so a refusal caused only by in-flight
reservations answers `429` instead. Two consequences worth relying on: `used` in a `402`
body is never comfortably under its own `cap`, and a caller who really does have headroom is
never given a status their SDK refuses to retry.

The rate limit **fails open**: if the platform limiter errors, the request proceeds. It is
availability protection, not the money control — the cap and the concurrency bound are, and
both are enforced transactionally in the database on the same path.

**Tool-call rounds are not bounded and nothing here pretends otherwise.** The broker is
stateless — the client sends its own history — so each round is an ordinary separate request
with no server-side notion of "round seven of a loop". Loops are bounded by these limits or
not at all.

> Every number above is a starting guess about agent behaviour nobody has measured yet, and
> is meant to be revisited once the usage ledger has real traffic in it.

---

## 5. Streaming

`stream: true` returns `text/event-stream`, passed through incrementally — never buffered.
Measured to survive the service-binding hop unbuffered at a flat ~27 ms cost.

**`200` means the stream started, not that it succeeded.** This belongs in bold in every
client:

```
data: {"choices":[…]}                       ← partial output already delivered
data: {"error":{"type":"provider_error",…}}
                                            ← stream closes here, NO [DONE]
```

On a mid-stream failure the server emits an error frame **and withholds `data: [DONE]`**.
Withholding the sentinel is the important half — send it after an error and a truncated
answer is indistinguishable from a finished one. Two independent signals, either sufficient
alone.

**A client must treat a stream that ends without `data: [DONE]` as incomplete.**

**Metering happens on the way past.** `stream_options.include_usage` is forced on, so the
provider emits a final frame carrying `usage`; the server reads it out of the bytes as they
flow to the caller and settles the request once the stream ends. The body is never `tee`d,
cloned or buffered to do this — a second branch drained at its own pace would mean holding
an entire long generation in memory for a slow reader — so at most one incomplete SSE line
is ever held.

Because the truth only exists at the last frame, a streamed request's usage lands in
`GET {AI}/usage` **shortly after the stream closes**, not when it starts.

**Hanging up cancels the upstream call.** Disconnecting stops the generation rather than
leaving the provider to finish an answer nobody will read, and the request is still charged
and still settled — see §4.4 for what an abort costs.

---

## 6. `GET {AI}/models`

The catalogue, filtered to what **this caller** may use.

```http
GET https://ai.tryatlas.cc/v1/models
Authorization: Bearer <jwt>
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-3.6-flash",
      "object": "model",
      "created": 1785801600,
      "owned_by": "google-vertex-ai"
    }
  ]
}
```

OpenAI's list shape, so `client.models.list()` on a stock SDK works unchanged.

**The list is derived from the price table and nothing else** — it is exactly the set that
`POST /chat/completions` will accept, so a model you see here is a model the meter will
take. `created` is the entry's effective date, the only date this table knows.

**No prices.** Rates are ours; a caller needs to know *whether* they may select a model,
not what it costs Atlas.

`GET` only — a `POST` here is `405`. A bearer is required, because the answer is
caller-specific.

The filter is `(grant override ?? tier list) ∩ catalogue`. **A caller with no grant gets
`403 no_entitlement` rather than an empty list** — access is off by default, and an empty
list would read as "Atlas has no models" instead of "you have not been granted any".

`Atlas-Org` matters here, not only on a completion: the grant that filters the list belongs
to the payer, and with no org declared the server looks for a personal grant instead.

---

## 6a. `GET {AI}/catalogue`

Everything **Atlas** supports, whatever this caller may select (ATL-149).

```http
GET https://ai.tryatlas.cc/v1/catalogue
Authorization: Bearer <jwt>
Atlas-Org: org_123
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-5",
      "object": "model",
      "created": 1786320000,
      "owned_by": "google-vertex-ai",
      "publisher": "anthropic",
      "entitled": false
    },
    {
      "id": "gemini-3.6-flash",
      "object": "model",
      "created": 1785801600,
      "owned_by": "google-vertex-ai",
      "publisher": "google",
      "entitled": true
    }
  ],
  "hasGrant": true
}
```

**Deliberately a different answer from `GET /v1/models`, and both are needed.** `/v1/models`
is the OpenAI-compatible one: it lists what you may pass to `create()`, and it refuses a
caller with no grant, because an empty list is the honest answer to a different question.
That is the wrong shape for a screen that has to say *"Atlas supports five models and your
organisation has been granted two"* — which needs the models you cannot use, and needs them
precisely when you have none. Serving both from one route breaks the SDK: either
`models.list()` starts returning models `create()` refuses, or the screen cannot be built.

**Listing is not granting.** `entitled` is computed from the same
`(grant override ?? tier list) ∩ catalogue` intersection the gate enforces, and posting a
completion for an `entitled: false` model gets the usual `403 model_not_allowed`.

`hasGrant` distinguishes *"you have not been granted AI access"* from *"you have been
granted a narrower set"* — different sentences with different next actions (ask an admin
for access, versus ask for more).

`publisher` is here and not on `/v1/models` because `owned_by` is the BYOK provider and is
the same string for every model we serve; on a multi-publisher surface like Vertex it
cannot answer "who made this".

**Authenticated, and still no prices.** Which models Atlas resells and from whom is
commercial information about our provider deal even without the rates attached. `GET` only;
a `POST` is `405`.

---

## 7. `GET {AI}/usage`

Where **this caller** stands against every ceiling that governs them.

```http
GET https://ai.tryatlas.cc/v1/usage
Authorization: Bearer <jwt>
Atlas-Org: org_123
```

```json
{
  "object": "list",
  "data": [
    {
      "scope": "org",
      "window": "monthly",
      "used": 307425,
      "cap": 350000,
      "reset": "2026-09-01T00:00:00.000Z"
    },
    {
      "scope": "org",
      "window": "daily",
      "used": 307425,
      "cap": 35000,
      "reset": "2026-08-05T00:00:00.000Z"
    }
  ]
}
```

One entry per enforced ceiling — the same set the gate checks, so a `402` can never name a
window this endpoint does not report. `scope` is `org`, `personal`, or `member` (a
per-member sub-cap, which is a second **ceiling** and not a second wallet: the org's counter
still moves when that member spends).

**Settled spend only — never `spend + reserved`.** In-flight reservations are an internal
device; including them would make the number jump up and back down as calls run. It follows
that `used` only ever increases within a window.

**Weighted tokens, not dollars.** The cap unit is weighted tokens, and showing an estimated
dollar figure beside it would invite the two to disagree.

Anyone who may spend may read this: a `402` already returns the same figures, so withholding
them here would only mean a caller has to be refused to learn their position. The
*per-member breakdown* — who in the org spent what — is employee-monitoring-shaped data and
is an admin surface (ATL-148 — [auth API §20](./atlas-auth-api.md)), not this one.

No grant → `403 no_entitlement`, not a row of zeroes.

---

## 8. `POST {AI}/features/{feature}`

The features surface — server-owned prompt and model, no `model` field from the caller.
`feature` is a **path segment, not a body field**, because it is a ledger rollup dimension
and a client-supplied value would be spoofable, corrupting the one report that decides where
engineering effort goes.

| `{feature}` | Today | Eventually |
| --- | --- | --- |
| `agent` | **`501 not_implemented`** | Org agent (**`PLANNED`**, ATL-20 / ATL-59) |
| anything else | **`404 unknown_feature`** — before any spend | — |

The envelope is fixed (`messages[]` + `context_ids[]`); the retrieval design behind it —
what a `context_id` refers to, Vectorize namespace scoping, context assembly, citation shape
— is deliberately still open.

---

## 9. Error reference

Codes reachable **today**:

| Status | `code` | When | Client should |
| --- | --- | --- | --- |
| **400** | `unknown_parameter` | Parameter outside the allowlist (incl. nested) | Fix the request. `param` names it. |
| **400** | `invalid_parameter` | Listed parameter with the wrong shape, or a body that is not JSON | Fix the request. |
| **401** | `unauthorized` | Missing / malformed / unverifiable bearer | Re-authenticate. **Do not** back off and retry. |
| **401** | `token_expired` | Verified but past `exp` | **Refresh once and retry.** Not a backoff case. |
| **402** | `cap_exceeded` | Settled spend has filled the weighted cap for a window | **Stop and tell the user.** `window` / `scope` / `used` / `cap` / `reset` say which and when. Never auto-retry — §9.1. |
| **403** | `no_entitlement` | No live grant for this payer. Access is off by default | Ask a platform admin for a grant ([auth API §17](./atlas-auth-api.md#17-platform-admin--ai-entitlements-atl-142)). Not retryable. |
| **403** | `org_not_covered` | `Atlas-Org` names a payer the token's `orgs` claim does not cover | Fix the header, or re-mint a token that covers the org. |
| **404** | `not_found` | No route matches the path | — |
| **404** | `unknown_feature` | `{feature}` segment not registered | — |
| **403** | `model_not_allowed` | Model has no complete price row effective at the request's date, or is outside this caller's catalogue | Call `GET {AI}/models`. Do not retry the same model. |
| **405** | `method_not_allowed` | Route exists, wrong method | Use the method the route declares (`POST`, except `GET {AI}/models` and `GET {AI}/usage`). |
| **413** | `request_too_large` | Raw body over 2 MB, rejected before parsing | Split the request. |
| **413** | `prompt_too_large` | Estimated prompt over 200K tokens | Trim `messages` **and** `tools`. |
| **429** | `rate_limited` | Too many of this caller's requests **in flight** (§4.5), too many **per minute** (§4.5), or **upstream provider** throttling | Back off and retry. `Retry-After` is set — `1` for a concurrency refusal, `60` for the rate limit. SDK auto-retry is correct here. |
| **501** | `not_implemented` | Registered feature, not yet built | — |
| **502** | `provider_error` | Upstream failed, or the gateway refused our own call | Retry cautiously. `error.upstream` carries the provider's body (capped at 2 KB). |
| **503** | `atlas_backstop_tripped` | **Our** gateway spend/rate backstop tripped | **Stop.** Atlas is broken, not you. Not a client-fixable condition. |

Every code this API defines is now reachable, in every meaning it has.

`429 rate_limited` covers three distinct causes — Atlas's concurrency bound, Atlas's
requests-per-minute limit, and an upstream throttle — deliberately under one code, because
the correct client behaviour is identical for all three and `Retry-After` carries the only
difference that matters.

### 9.1 Why `cap_exceeded` is `402` and never `429`

This is load-bearing. **Stock OpenAI SDKs auto-retry `429` with backoff.** A monthly cap
answering `429` would put every capped agent into an automatic retry loop against a wall it
cannot clear for up to three weeks. `402` is in no SDK's retry set.

So the three retry semantics are deliberately distinct: `402` stop and tell the user,
`429` back off and retry, `503` stop because Atlas is broken.

### 9.2 Upstream failures are classified, never forwarded raw

`atlas-ai` never passes a raw `429` through — three failures look alike on the wire and
warrant opposite client behaviour. The discriminator is structural rather than heuristic
(measured): a **gateway** error is a JSON *object* carrying `name: "AiGatewayError"` and a
numeric `internalCode`, while an **upstream Vertex** error passes through as the provider's
native body — a bare *array*.

| `internalCode` | Gateway meaning | Client sees |
| --- | --- | --- |
| `2003` | Rate limit tripped | `503 atlas_backstop_tripped` |
| `2041` | Spend limit tripped | `503 atlas_backstop_tripped` |
| `2005` | Provider unreachable / BYOK failure | `502 provider_error` |
| `2009` | Gateway authentication failed | `502 provider_error` |
| *(none — bare array)* | Vertex's own error | `429 rate_limited` or `502 provider_error` |

A backstop trip is a `5xx` because it is **our** failure, not the caller's — and returning
their own `429` would tell them to retry against a wall we put up.

---

## 10. Operational surfaces (not client-visible)

### 10.1 Gateway metadata

Four namespaced entries ride every outbound call. Clients cannot set or influence them; they
are documented because they are what makes a support conversation possible.

| Key | Value | Why |
| --- | --- | --- |
| `org_id` | `org_<id>` / `org_none` | Attribution; the only handle for targeted log deletion. |
| `user_id` | `usr_<sub>` / `usr_none` | Per-seat forensics. |
| `feature` | `feat_raw`, `feat_agent`, `feat_embed` | Rollup dimension. |
| `request_id` | `req_<ULID>` | **Log → ledger direction.** Returned to you as `x-atlas-request-id`. |

The gateway's cap is five entries and a sixth is dropped silently; the fifth is held in
reserve because a free slot is cheap now and un-buyable later. Values are prefixed
**unconditionally** — log filtering evaluates key and value as two independent predicates,
so `key=value` is inexpressible and only a globally unique *value* can target one org.

Log payload capture is sent **explicitly on every request, in both states**, never left to
the gateway default — `false` normally, `true` only inside a capture window the customer
opened (§10.4). No prompt or response content is stored by **Atlas** in either state; the
switch only decides whether the *gateway* keeps the payload.

### 10.4 Prompt capture (ATL-145)

`GET /api/auth/capture?orgId=…` · `POST /api/auth/capture` — on the **auth** worker, not
this one, because it is authorised on a session rather than a token.

An organisation can turn on payload capture for itself, for a bounded window, per surface.
While a window is open, `cf-aig-collect-log-payload: true` rides that organisation's
requests on that surface and the gateway keeps the prompt and the reply.

**Only an admin of that organisation can open one.** Not a platform admin, not with a
support ticket. This is the load-bearing property, and it is what makes the customer-facing
sentence *"Atlas cannot read your prompts unless you turn it on"* literally true rather than
nearly true — a staff bypass, even an audited one, would downgrade it to *"staff can turn it
on and we log when they do"*. Atlas staff may ask; they may never enable. The accepted cost
is a round trip on every support escalation.

| Property | Value | Why |
| --- | --- | --- |
| Who may open | organisation `admin`, or a personal grant's owner | the subject that owns the data consents |
| Who may read the state | any member | you are the person whose prompts it stores |
| Maximum window | 24h, renewable, **never auto-renewing** | a renewal is a fresh, deliberate act |
| Surfaces | `raw` and `features`, independent | `raw` is source code; `features` is largely reconstructable |
| Expiry | a timestamp compared at request time | no scheduler that can fail to turn it off |
| Retroactive | **never** | capture is proactive; escalation is reactive |
| Retention | payloads deleted 7 days after the window closes | window short, investigation longer, then the rows go |
| Audit | actor, surface, expiry, **mandatory reason** | answers "why were these prompts stored on the 14th?" |

`POST` body is `{ orgId, surface, hours, reason }`; `hours: 0` closes the window through the
same audited write, because stopping early is exactly as legitimate as starting. The expiry
is computed from the server's clock — a client-supplied timestamp would make the ceiling
advisory. Refusals: `401 unauthenticated`, `403 not_org_admin` (deliberately *not*
`not_platform_admin` — a different axis), `404 no_grant`, `400 invalid_request`.

**Deletion runs in CI, not in a worker** (`.github/workflows/purge-captured-payloads.yml`).
Removing gateway logs needs an account-scoped Cloudflare token, and one leaked from a worker
would expose every BYOK provider key on the account. The filter narrows on subject, surface
*and* time, so only requests made while capture was actually running lose their log row —
any one of the three missing over-deletes into rows that never carried a payload. See
`atlas-auth-api.md` §21.4 for the measured filter semantics.

One accepted loss, recorded rather than discovered: deleting a captured row removes the
**whole** log entry, since there is no way to strip a payload and keep the metrics. The
gateway's independent cost figure is therefore lost for those requests. Our own ledger is
unaffected and remains the system of record.

### 10.2 The usage ledger (ATL-143)

Every request leaves a durable record in **Atlas's own D1 ledger**, which is the system of
record for billing. The gateway's log is a cross-check joined through a nullable log id,
never a dependency: refusals never reach the gateway at all, reading its logs needs an
account-scoped credential that must never live in a worker, and those logs rotate on a count
limit we do not control.

The record is written asynchronously. The worker enqueues one event on `atlas-ai-usage`
inline, **awaits it, and does not catch** — the enqueue is the durable commit point, so a
queue outage fails the request rather than serving it uncounted (a served-but-unrecorded
request reconciles later as usage that never happened, which is a silent refund). A batched
consumer does the inserts, off the path that spends money.

**Two tables, deliberately:**

| Table | One row is | Written for |
| --- | --- | --- |
| `ai_usage` | one metered request | served (`ok`), abandoned (`aborted`), provider failure (`error`), and embeddings |
| `ai_denial` | one `(subject, reason, minute)` bucket, with a count | every refusal our own controls produced |

Folding the two together would make every billing column nullable, so every billing query
would need a status filter — and the one somebody forgets produces a wrong invoice, silently.
Denials are coalesced because a capped agent retries in a loop: uncoalesced, the record of a
denial can cost more than the usage it denied. The signal kept is "this org hit its cap four
hundred times on Tuesday"; the detail lost is which four hundred requests.

What each usage row carries: the wallet and member, provider, model and feature; the status;
the token breakdown the charge was computed from; the weight applied; whether that weight was
**estimated** rather than measured; the gateway log id where one exists; and the timings.

- **`estimated = 1`** is the flag §4.4's over- and under-charges previously had nowhere to
  live: a clean reply with no usable `usage` (charged at the reservation) and an abandoned
  stream (charged prompt-plus-bytes) are both marked, so a rollup can keep measured and
  estimated spend in separate columns rather than one indistinguishable sum.
- **Denial `reason`** is the error `code` the caller saw, except that a concurrency refusal is
  recorded as `concurrency` and a lost admission race as `contention` — both answer
  `429 rate_limited` on the wire, and telling them apart is the point of the table.
- **Embeddings** (`provider = workers-ai`, `feature = embed`) are recorded at **weight zero**
  and with a null gateway log id. They are triggered by a commit rather than a person, and
  capping that path would let an over-budget org silently stop indexing — a RAG index with a
  hole returns wrong answers forever with no error anyone sees. Volume is visible; the cap
  ignores it.
- **A `400`** — a malformed body, an unlisted parameter — is *not* a denial row. It is a
  client bug rather than a policy decision, and counting it beside "hit the cap" would put two
  unrelated things in the one column an operator reads as budget pressure.

**No prompt or response content, ever** — not truncated, not "the first 200 characters for
debugging". A truncated prompt is still customer source code, and this ledger shares a
database with identity, so a payload column would make one compromise simultaneously an
identity breach and a source-code breach.

The counter (`ai_counter`) and the ledger are two numbers with a stated tiebreak: **the
counter is authoritative for enforcement, the ledger for reporting and billing.** Correcting
the counter toward the ledger is specified but **not yet owned by a ticket** — ATL-147
reconciles against the *gateway log* and never mutates either number — so the tiebreak is
currently a rule, not a job. Rollups and retention are §10.3.

### 10.3 Rollups, retention, and the nightly job (ATL-144)

A cron on `atlas-ai` runs at **03:17 UTC** and does three things: rolls the ledger's raw rows
into daily totals, prunes what is past retention, and sweeps abandoned reservations.

| Table | Kept | Why |
| --- | --- | --- |
| `ai_usage`, `ai_denial` | **90 days** | Covers a billing dispute and a "what happened last month" investigation. Beyond that they mostly tie a named user to timestamped activity — a privacy liability that shrinks for free by expiring. |
| `ai_counter` | **90 days past the window's close** | The one enforcement table that only grows: a row per subject per day wherever a daily cap applies, and nothing on the request path removes one. Only the *current* windows are ever read, so a window this old is unreadable by construction and what it recorded lives on in the rollups. |
| `ai_usage_daily` | **indefinitely** | It is what answers "what did this org cost us last quarter" once the raw rows are gone. |

`ai_usage_daily` is keyed `(subject_key, day, provider, model, feature)`, and both `model` and
`feature` are load-bearing. Dollars are a **query-time join against the price table**, never a
stored column — prices are versioned and back-datable, so a frozen dollar figure would be a
second answer that disagrees. A rollup that collapsed `model` would therefore be permanently
**unpriceable** the day the raw rows expire. `feature` earns its place because "is the org
agent or the desktop raw surface eating the budget" is the first question anyone asks of this
data. Aggregating a dimension away at read time is free; disaggregating one after pruning is
impossible.

`weighted_measured` and `weighted_estimated` are **two columns, never one sum** — added
together at rollup time, no later report could say how much of a bill was measured and how
much was guessed, and that is exactly the moment the raw rows disappear.

Three properties worth stating because they are what the job is designed around:

- **Days are recomputed wholesale, not incremented.** Queue retries and dead-letter replays
  insert rows into days that have already been rolled, and an incremental job would have to
  know which rows it had already counted — the one fact a replay destroys. Each run re-rolls a
  trailing **3-day** window. A *correction* older than that never reaches a rollup; the raw
  row is still there to be found by hand for the rest of the quarter.
- **A day that was never rolled at all is caught up**, however far back it is, as long as its
  raw rows are still inside retention. Otherwise a cron outage longer than the window — or a
  ledger that already had rows before this job first ran — would lose those days silently and
  then prune them, which is precisely the loss the rollups exist to prevent.
- **Only closed UTC days are rolled.** A partial day written at 03:17 would read as that day's
  total; a missing row reads as "not rolled yet", which is true.
- **The day boundary is UTC and is the same boundary the enforcement counters reset on** —
  literally the same helper. Rolling on one boundary while counters reset on another shows a
  console figure that contradicts a refusal a customer just received, with both numbers
  individually correct.

Pruning is clamped to stay behind the rollup window, so a day being recomputed can never have
its rows deleted first. The reservation sweep is **janitorial only**: the correctness path for
a stale reservation is still the lazy per-subject reclaim at gate time (§4.4), because a
nightly sweep alone would leave an affected subject blocked until the job next ran.

---

## 11. Planned surface

Written down so clients can be built against the final contract. **None of this answers
today.**

| Endpoint / behaviour | Status | Ticket |
| --- | --- | --- |
| `POST {AI}/features/agent` — real retrieval | `PLANNED` | ATL-20 / ATL-59 |
| Nightly reconciliation against the gateway log | `PLANNED` | ATL-147 |
| Backstop trip pages us instead of failing silently | `PLANNED` | ATL-146 |
| Org-admin-initiated prompt capture window | **LIVE** | ATL-145, §10.4 |

> ### ⚠️ Every request is recorded and rolled up; nothing yet reconciles the record
>
> The cap is enforced (ATL-138), access is off by default, a served request is charged what
> the provider reported (ATL-140), a caller's parallelism and request rate are bounded
> (ATL-141), every request — served, refused, errored or embedded — leaves a row in the
> ledger (ATL-143), that ledger is rolled up, pruned and swept nightly (ATL-144), a
> platform admin can grant and revoke a tier (ATL-142) and change a price safely (ATL-139),
> and there is a console for all of it (ATL-148). What remains:
>
> - **Nothing reconciles yet** (ATL-147). No job compares our figures against the gateway's
>   log, so the price-table drift that check exists to catch would go unnoticed. Separately,
>   **nothing corrects the counter toward the ledger** — the tiebreak §10.2 states is not owned
>   by any ticket, ATL-147 included, so a counter that drifts from the ledger stays drifted.
> - **A reply with no usable `usage` still settles at its reservation**, and an abort at
>   prompt-plus-bytes — the deliberate over- and under-charges in §4.4. Both are now *flagged*
>   `estimated` in the ledger, so they are countable, but nothing corrects them.
> - **A streamed request settles after its last byte**, so an isolate lost mid-stream loses
>   both that settle and its ledger row: the reservation is reclaimed at its TTL and the
>   request goes uncharged and unrecorded. Unavoidable while the truth only exists at the
>   final frame — the alternative is charging the estimate up front and never correcting it.
> - **Tiers still have no admin surface** (unowned). Grants and prices are both editable from
>   the console at `/admin` — see [auth API §17–§20](./atlas-auth-api.md#17-platform-admin--ai-entitlements-atl-142)
>   — but adding or changing a tier is still a hand-written row, so the `starter` tier the
>   migrations ship is the only one a fresh deployment can grant.
> - **The platform surface is not rate-limited.** `/api/auth/platform/*` and
>   `/api/auth/usage` sit before Better Auth's handler and draw on neither of its budgets.
>   There is no credential to guess — session plus deploy-time allowlist — but the refusal
>   path is anonymously reachable and costs a session lookup per call.
>
> - **The provider-side alarm is not wired.** Alarm layers 1 and 2 (below) both run inside
>   `atlas-ai`, which is the system that might itself be the bug. The independent GCP budget
>   notification — the only layer that still works when the broker is looping, or when spend
>   never touches the gateway at all — is written up in
>   [`docs/runbooks/gcp-spend-alarm.md`](../runbooks/gcp-spend-alarm.md) but has not been
>   applied (ATL-146 AC6).

### 11.1 What happens when a backstop trips (ATL-146)

The ceilings on gateway `atlas` are **Atlas-wide**, so a trip refuses every customer at
once. Two alarms fire off it, chosen to fail differently:

| Layer | When | Severity | Mechanism |
| --- | --- | --- | --- |
| **1 · in-band** | The instant a call is refused with `2003`/`2041` | `critical` | `atlas-ai` writes an `ai_denial` row with reason `gateway_backstop` and POSTs an incident to `ALARM_WEBHOOK_URL` |
| **2 · leading indicator** | Every 15 min, at 50% then 80% of the $100/24h ceiling | `warning`, then `critical` | Computed from **our own ledger**, so it fires hours before the ceiling and the ceiling can be raised deliberately rather than during an incident |
| **3 · independent** | Hours-lagging | — | GCP budget + Pub/Sub. **Not applied** — see the runbook |

The page body is the same shape for both layers:

```jsonc
{
  "source": "atlas-ai",
  "severity": "critical",
  "kind": "gateway_backstop",         // or "spend_leading_indicator"
  "summary": "Atlas AI spend backstop tripped (rule c7c2fd16): …",
  "detail": { "ceiling": "spend", "internalCode": 2041, "rule": "c7c2fd16", "subjectKey": "org:…" },
  "at": 1785801600000
}
```

Three properties worth knowing before relying on it:

- **The log line is the alarm; the webhook is delivery on top of it.** Every incident is
  written to the worker log *before* any network call, so an unset `ALARM_WEBHOOK_URL`, a
  webhook outage or a hung POST loses the page but never the record.
- **The alarm fails open.** It fires on a path that is already broken, so a delivery failure
  must not replace a `503` carrying an explanation with an unhandled exception. This is the
  deliberate opposite of the ledger's fail-closed rule, which protects money.
- **Layer 2 measures our number, not the gateway's.** The gateway's meter over-counts cached
  input by 2.33× (one of five measured defects, ATL-73 + ATL-134), so on cache-heavy traffic
  its figure climbs faster than ours and R1 can trip *before* the leading indicator warns.
  Ours is the better figure but not purely measured either — charges settled from a
  reservation estimate run high — so the alarm body carries `estimatedUsd` beside the total.
  Quantifying the gateway-side divergence is ATL-147.

**Every alarm is deduped, and the window differs by layer.** Layer 2 fires once per threshold
per UTC day; layer 1 fires once per ceiling per minute, so a sustained outage keeps paging
without emitting one page per refused request (hundreds a minute under R4). `ai_alarm`'s
primary key is the dedupe, not the cadence.

Two known gaps in this area:

- **`atlas-dev` is independent but unused.** It carries none of the production ceilings
  (verified 2026-08-05), yet `AI_GATEWAY_ID` is pinned to `atlas`, so a `wrangler dev`
  session still counts against production. Blocked on `atlas-dev`'s BYOK binding (ATL-134).
- **No PostHog event.** ADR-0008 decision 6 names one; `atlas-ai` carries no PostHog client,
  and the `ai_denial` row answers the operational question the event would have.

---

## 12. Integration guide

### 12.1 Any OpenAI SDK

Only `baseURL` changes. The API key slot carries the Atlas JWT.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://ai.tryatlas.cc/v1",
  apiKey: atlasAccessToken,                    // the JWT, refreshed as below
  defaultHeaders: { "Atlas-Org": orgId },      // optional; omit for a personal grant
});

const res = await client.chat.completions.create({
  model: "gemini-3.6-flash",
  messages: [{ role: "user", content: "…" }],
});
```

### 12.2 Desktop checklist

- **Refresh the JWT before it expires**, not after a `401`. TTL is 10 minutes
  (`GET {AUTH}/token`); re-mint at **T-60s**.
- **Branch on status, not message.** `402` stop and tell the user · `429` back off ·
  `401 token_expired` refresh once · `503 atlas_backstop_tripped` stop, Atlas is broken.
- **Never trust `200` on a stream.** Absence of `data: [DONE]` means the answer is
  incomplete — surface that, do not render it as finished.
- **Do not send `n` or `user`.** Both are rejected.
- **Handle `403 no_entitlement` as a setup problem, not a failure.** Access is off by
  default; the user needs a grant, and retrying will never produce one.
- **Read `GET {AI}/usage` to show a budget**, not to decide whether to send. It reports
  settled spend only, so it lags the gate by whatever is in flight — and a streamed
  request lands there just after its stream closes, not when it starts.
- **Budget `tools` against the prompt ceiling.** A large tool schema counts.
- **Log `x-atlas-request-id`.** It is the only handle that makes a request diagnosable
  afterwards.

### 12.3 Web app (ATL-137)

The browser calls the web origin under `/api/ai/*`; the web worker strips the prefix, mints
an access token **server-side** off the session cookie, attaches it as a bearer, and forwards
over the `AISVC` binding. Session cookies stay first-party same-origin — no CORS, and **no AI
credential is ever exposed to page scripts**.

```ts
// Same contract as §4, minus the credential — the proxy attaches it.
await fetch('/api/ai/v1/chat/completions', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'Atlas-Org': orgId },
  body: JSON.stringify({ model, messages, stream: true }),
})
```

Details that matter:

- The token is **cached per session and re-minted 60 s before `exp`**, so no request ever
  carries a nearly-expired token. The cache is per-isolate memory; a cold isolate re-mints.
- The proxy **strips `cookie` and any `X-Atlas-*`** before forwarding, and **overwrites**
  any `Authorization` the page supplied — a page cannot smuggle its own bearer through.
- An unauthenticated request is refused **`401` at the proxy**, in this same error envelope,
  without reaching `atlas-ai`.
- The response body is handed back **unbuffered**, so streamed answers arrive incrementally.

`src/lib/ai.ts` in `apps/web` is the client helper, and the **AI** tab on the dashboard is a
working example of the whole path.

---

## 13. Status-code summary

| Code | Meaning in this API |
| --- | --- |
| **200** | Success. On a stream, *the stream started* — see §5. |
| **400** | Unlisted/nested-unknown parameter, bad shape, or unparseable body. |
| **401** | Missing, invalid, or expired bearer. |
| **402** | Weighted cap for a window exhausted. Body names `window`, `scope`, `used`, `cap`, `reset`. Never `429` — §9.1. |
| **403** | No entitlement, payer not covered by the token, or the model is not in this caller's catalogue. |
| **404** | No route, or unknown `{feature}` segment. |
| **405** | Wrong method on a real route. |
| **413** | Body over 2 MB, or prompt over 200K estimated tokens. |
| **429** | Concurrency bound, requests-per-minute limit, or **upstream** throttling. Retryable, `Retry-After` set — §4.5. |
| **501** | Registered feature, not yet built. |
| **502** | Provider or gateway failure. `error.upstream` carries detail. |
| **503** | Atlas's own gateway backstop tripped. Not client-fixable. |

---

## 14. Verification checklist (kept honest against source)

| Claim in this doc | Verified against |
| --- | --- |
| Both doors verify the same JWT; identity headers ignored | `apps/ai/src/index.ts`, `apps/ai/test/ai.test.ts` |
| Allowlist, nested-strict rejection, `param` naming | `packages/contracts/src/ai.ts`, `apps/ai/test/ai.test.ts` |
| Double model prefix, `max_tokens` clamp/inject, `include_usage` forced | `apps/ai/src/broker.ts`, `apps/ai/test/ai.test.ts` |
| Ceilings incl. `tools` counting toward the prompt | `apps/ai/src/broker.ts`, `apps/ai/test/ai.test.ts` |
| Four metadata entries, namespaced | `packages/contracts/src/ai.ts`, verified on a real gateway log row (ATL-135) |
| `internalCode` → status mapping | `apps/ai/src/gateway.ts`, `apps/ai/test/ai.test.ts`, ADR-0008 §5 |
| Error envelope and `type` vocabulary | `apps/ai/src/errors.ts` |
| Stock-SDK compatibility, usage forced on despite `include_usage: false` | Live run against the production `atlas` gateway (ATL-135) |
| Gateway backstop values R1/R2/R4 | ADR-0008 §4, applied 2026-08-04 |
| Catalogue = price table; unpriced model fails closed | `apps/ai/src/{catalogue,pricing}.ts`, `apps/ai/test/catalogue.test.ts` |
| `GET /v1/models` shape, and that it carries no prices | `apps/ai/src/index.ts`, `apps/ai/test/catalogue.test.ts` |
| Per-model publisher; a publisher-less row is unroutable, not guessed | `packages/contracts/src/{ai,pricing}.ts`, `apps/ai/test/vertex-catalogue.test.ts` |
| `GET /v1/catalogue` answers a caller with no grant, and listing is not granting | `apps/ai/src/index.ts`, `apps/ai/test/vertex-catalogue.test.ts` |
| The five shipped models and their publishers | `packages/db/migrations/0014_marvelous_lilandra.sql`, `apps/ai/test/vertex-catalogue.test.ts` |
| Claude goes to `:rawPredict` with a Messages body, never to the compat endpoint | `apps/ai/src/{gateway,anthropic,index}.ts`, `apps/ai/test/anthropic.test.ts` |
| Anthropic replies and streams are translated back to OpenAI, usage included | `apps/ai/src/anthropic.ts`, `apps/ai/test/anthropic.test.ts` |
| `claude-opus-4-8` is priced and callable | `packages/db/migrations/0015_curious_shadow_king.sql`, `apps/ai/test/anthropic.test.ts` |
| Reserve-then-settle holds the cap under concurrency | `apps/ai/src/gate.ts`, `apps/ai/test/gate.test.ts` |
| Safety margin applied exactly once, at the tier's dollar conversion | `apps/ai/src/pricing.ts`, `apps/ai/test/gate.test.ts` |
| Access off by default; revocation effective on the next request | `apps/ai/src/entitlement.ts`, `apps/ai/test/gate.test.ts` |
| Sub-cap refuses the member while the org's counter moves | `apps/ai/src/{entitlement,gate}.ts`, `apps/ai/test/gate.test.ts` |
| UTC windows; `402` body fields; usage excludes reservations | `apps/ai/src/gate.ts`, `apps/ai/test/gate.test.ts` |
| A request is charged the provider's counts, streamed or not | `apps/ai/src/metering.ts`, `apps/ai/test/metering.test.ts` |
| Output by subtraction; cached at the cached weight; a clean reply with no usage falls back to the reservation | `apps/ai/src/{metering,pricing}.ts`, `apps/ai/test/metering.test.ts` |
| An abort charges prompt-plus-bytes-delivered; a hangup cancels upstream | `apps/ai/src/metering.ts`, `apps/ai/test/metering.test.ts` |
| Mid-stream failure emits an error frame and withholds `data: [DONE]` | `apps/ai/src/metering.ts`, `apps/ai/test/metering.test.ts` |
| Concurrency bounds (4 per member, 20 per payer) enforced inside the gate's own write | `apps/ai/src/{gate,limits}.ts`, `apps/ai/test/limits.test.ts` |
| Rate and concurrency refusals are `429` with `Retry-After`, and a cap refusal is not | `apps/ai/src/index.ts`, `apps/ai/test/limits.test.ts` |
| A `402` is reported only when settled spend overflows the cap; a reservation-only refusal is `429` | `apps/ai/src/gate.ts`, `apps/ai/test/limits.test.ts` |
| The rate limiter is keyed on the token subject, runs before any D1 read, and fails open | `apps/ai/src/limits.ts`, `apps/ai/test/limits.test.ts` |
| One ledger row per served request, and one after a redelivery of the same event | `apps/ai/src/ledger.ts`, `apps/ai/test/ledger.test.ts` |
| Refusals coalesce per subject/reason/minute and stay out of the billing table | `apps/ai/src/ledger.ts`, `apps/ai/test/ledger.test.ts` |
| An abandoned stream is recorded `aborted` and `estimated`; a clean one as neither | `apps/ai/src/{index,metering}.ts`, `apps/ai/test/ledger.test.ts` |
| An enqueue failure fails the request rather than being swallowed | `apps/ai/src/ledger.ts`, `apps/ai/test/ledger.test.ts` |
| Embeddings are recorded at weight zero, with a null gateway log id, queryable beside generation | `apps/ai/src/vectorize-workflow.ts`, `apps/ai/test/ledger.test.ts` |
| No ledger row contains any part of a prompt or a completion | `packages/db/src/schema.ts`, `apps/ai/test/ledger.test.ts` |
| Rollups reproduce the raw rows, and a second run changes nothing | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |
| A row arriving late into an already-rolled day inside the window is picked up | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |
| Only closed UTC days are rolled, on the counters' own boundary | `apps/ai/src/{nightly,entitlement}.ts`, `apps/ai/test/nightly.test.ts` |
| Pruning stays behind the rollup window; measured and estimated stay separate columns | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |
| A day behind the window that was never rolled is caught up; one already rolled is not | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |
| Counter rows for long-closed windows are dropped, current ones untouched | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |
| The janitor clears expired reservations and leaves live ones alone | `apps/ai/src/nightly.ts`, `apps/ai/test/nightly.test.ts` |

Anything marked `PLANNED` is verified against the spec on ATL-74 and its ticket, **not**
against code — because there is none yet.
