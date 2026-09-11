# Request to the server team: per-model metadata on `GET /v1/catalogue`

**From:** Atlas desktop (native agent, ADR-0007)
**To:** whoever owns `apps/ai` in `tryatlas/server`
**Date:** 2026-09-11
**Priority:** the context window is the one that affects users today; the rest is polish.

## What we are asking for

Five optional fields on every row of `GET /v1/catalogue` (and, if convenient, `GET /v1/models`):

| Field | Type | Meaning | Why the desktop needs it |
|---|---|---|---|
| `display_name` | `string` | The name a person sees. `"Claude Opus 5"`, not `claude-opus-5`. | The model picker shows it. Without it the picker shows raw slugs. |
| `description` | `string \| null` | One sentence. `"The most capable model Atlas serves, and the most expensive."` | Second line under the name in the picker. |
| `context_window` | `integer` | The prompt ceiling for that model, in tokens, as the gateway enforces it. | **The important one.** The engine's auto-compaction fires at 90 % of this. Without it the engine has no ceiling to compact against, and a long thread ends with the gateway's `413` instead of compacting. |
| `sort_order` | `integer` | Picker position, ascending. | The picker offers rows in the order the gateway returns them, and the **first entitled row is the default model** for a new session. Today that order is whatever the `ai_model_price` query happens to return. |
| `default` | `boolean` | The model a new session should start on. | Same reason. If absent, the first entitled row by `sort_order` is the default. |

Also welcome, not required: `input_modalities: string[]` (`["text","image"]`) so the desktop can stop assuming every model takes images.

## The contract we already honour

The desktop parses every one of these as **optional** and ignores unknown fields, so they can ship one at a time and in any order. A row without them still works (name = slug, no description, no compaction ceiling). Nothing on the desktop needs to be coordinated with the deploy.

Rows are read from `data[]` on `/v1/catalogue`; `entitled: false` rows are listed but never offered. `hasGrant` is read. Everything else on the row (`object`, `created`, `owned_by`, `publisher`) is ignored.

Reference: `crates/atlas-native-agent/src/engine/catalog_cache.rs`, `GatewayRow`.

## Where it plugs in on the server

- `apps/ai/src/index.ts`, `listCatalogue` (~L516): the `data` mapping is one object literal per price row. Add the fields there.
- `packages/contracts/src/pricing.ts`: `MODEL_PRICE_COLUMNS` and `toModelPrice` are the named select list and mapper; a new column is a compile error at the mapper until it is added, which is the design.
- Storage: either new nullable columns on `ai_model_price` (`display_name text`, `description text`, `context_window integer`, `sort_order integer`, `is_default integer`), or a small `ai_model_meta` table keyed by `model` joined in `catalogueAt`. The price table is versioned by `effective_from`; metadata is not, which argues for the separate table so a price change does not require restating the name.
- The admin price console (`apps/web/src/components/admin/prices-panel.tsx`) is the natural place to edit them.

## Values to seed

For the models the gateway serves today. Context windows are the gateway's enforced ceilings, not the providers' advertised maxima — the desktop used 200,000 for every row before this change, which matched the gateway's prompt cap at the time.

| `id` | `display_name` | `context_window` | `sort_order` | `default` |
|---|---|---|---|---|
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | *(gateway's cap)* | 1 | true |
| `claude-opus-5` | Claude Opus 5 | *(gateway's cap)* | 2 | |
| `claude-opus-4-8` | Claude Opus 4.8 | *(gateway's cap)* | 3 | |
| `gemini-3.6-flash` | Gemini 3.6 Flash | *(gateway's cap)* | 4 | |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | *(gateway's cap)* | 5 | |
| `glm-5.3-flash` | GLM 5.3 Flash | *(gateway's cap)* | 6 | |

Descriptions the desktop used to ship, if useful as a starting point: Sonnet "Strong agentic coding at the mid tier."; Opus 5 "The most capable model Atlas serves, and the most expensive."; Opus 4.8 "The previous Opus release, priced identically to Opus 5."; Gemini Flash "Fast and inexpensive; Atlas follows the latest Flash rather than pinning a version."; Flash Lite "The cheap tier — roughly a fifth of Flash on input."; GLM "A reasoning model — it thinks before answering, so even short replies spend thinking tokens."

## One related defect

`openai/gpt-5.6-sol` is returned with `entitled: true` and fails every completion with `502 provider_error` wrapping an upstream `402` (no funded route, measured 2026-09-05). The desktop no longer filters it out — ADR-0007 keeps no exclude list — so it now appears in the picker and fails at turn time. Either fund the route or stop marking it entitled.

## How to tell it worked

Once a row carries `display_name`, the desktop picker shows it on the next engine connect (or on the picker's Refresh) with no desktop release. Once it carries `context_window`, `auto_compact_token_limit` on the engine's loaded record is 90 % of it, and a long thread compacts instead of hitting `413`.
