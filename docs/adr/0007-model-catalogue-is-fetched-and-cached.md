# ADR-0007: The native agent's model catalogue is fetched from the gateway and cached; nothing in code names a model

**Status:** Accepted (2026-09-11). Revises spec decision D3 and resolved question 11 of `docs/atlas-agent-codex-port-spec.md`.

## Context

Atlas Agent's model list was a six-row array in `crates/atlas-native-agent/src/engine/catalog.rs`, with a `DEFAULT_MODEL` constant beside it. D3 chose that deliberately: the engine's own remote catalogue fetch cannot parse the gateway's stock OpenAI list, so the seam authored the engine's record by hand and wrote it to `models.json` at every connect.

The array drifted from the gateway the moment it was written. It excluded two models the gateway lists, by hand, with a comment explaining why; it pinned a default the gateway does not know is the default; and every catalogue change on the gateway's side was a code change, a build and a release on Atlas's side. The user's instruction was direct: no hardcoded model list.

Three facts constrain the replacement:

- The engine reads `model_catalog_json` at every config load and hard-errors on a missing or empty file, but the *live* list it serves is a plain vector captured once at app-server start. A slug the engine did not load at startup gets invented metadata (`model_info_from_slug`) that advertises reasoning summaries and drops `apply_patch`, and the gateway answers those fields with `400`. So a changed slug set needs a reconnect.
- The gateway's `GET /v1/catalogue` returns only `id`, `publisher`, `entitled` and `hasGrant` per row today. Display name, description and context window do not exist on the wire.
- `entitled` is answered per organisation (the `Atlas-Org` header). A list fetched for one org says nothing about another.

## Decision

1. **The catalogue is the gateway's.** At every engine connect the seam resolves it in this order: a cached copy under one hour old fetched for the same org; else `GET /v1/catalogue` with a five-second timeout, which on success overwrites the cache; else a cached copy of any age for the same org. Rows with `entitled: false` are dropped. The rest are offered in the gateway's order, and the first is the model a session runs on before any pick.

2. **The cache is the only fallback.** With no cache and no gateway answer, the native connect fails with a message that says so, and the picker is empty. No list authored in Atlas stands in. A signed-out user with a same-org cache still connects; their turns fail as they do today without an account (D14).

3. **Per-model metadata is the gateway's to send.** Atlas reads `display_name`, `description` and `context_window` from a catalogue row when present and requests them from the gateway team (`docs/requests/gateway-catalogue-metadata.md`). Until they ship: the name is the slug, there is no description, and there is no context window, so the engine's auto-compaction is off for that row and the gateway's `413` is the ceiling. Accepted as an interim cost.

4. **No exclude list.** Every entitled row is offered, including one the gateway advertises but cannot route today (`openai/gpt-5.6-sol`, which fails every completion with a `502`). That is a gateway defect and is fixed there; a list of exceptions here would be a second hardcoded catalogue.

5. **Refresh on connect and on demand.** The connect-time resolve above is the normal refresh. The model picker gains a refresh action for the native agent. A refresh whose slugs and context windows match what the running engine loaded swaps names and descriptions into the live connection. One whose fingerprint differs drops the native connection — the same teardown sign-out performs — after telling every open native session, which then shows the existing Restart affordance and rebinds by `thread/resume` on its next send. A refresh is refused while a native turn is running; the cache is already rewritten, so nothing is lost by asking the user to stop first. Switching to another synced organisation triggers a silent refresh, because the connection is not re-established on an org switch and the previous org's list must not survive it.

6. **What is cached is the gateway's rows, not the engine's records.** The projection into the engine's forty-field `ModelInfo` — what the wire can carry, which prompt to use — stays a decision in `catalog.rs` that can change without invalidating any user's cache. The cache lives in the engine's home (`<config>/atlas-agent/engine/catalogue-cache.json`), so a profile wipe takes it with the rest of engine-private state (D9).

## Consequences

- `DEFAULT_MODEL`, `CONTEXT_WINDOW`, the model array and every test that named a model are gone. The integration tests stand up a mock gateway that serves a fixture catalogue; the ids they assert on are the fixture's, not the product's.
- `EngineSettings.model` is `Option<String>`: `Some` on the dev Responses provider, `None` on the gateway. `EngineConnection` carries a `LiveCatalogue` that both the picker and every thread start read.
- The picker's order and default are whatever order the gateway's price table returns. The metadata request asks for an explicit `sort_order` and `default` so this stops being incidental.
- Long threads on rows without a context window will hit the gateway's size limit instead of compacting until the gateway sends the number.
- A fork-side change — a swappable catalogue inside the engine's `StaticModelsManager`, injected through `InProcessClientStartArgs` and preserved across the MCP-refresh rebuild — would remove the reconnect on a changed slug set. About five files in `vendor/codex`, two new fork-only invariants. Not done; recorded here as the upgrade path if the teardown proves annoying in practice.
- The provider is unchanged and still hardcoded to the gateway. Only the model catalogue moved.
