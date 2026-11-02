# Request to the server team: a Clef route on the gateway

**From:** Atlas desktop (Security Agent, ATL-985)
**To:** whoever owns `apps/ai` in `tryatlas/server`
**Date:** 2026-10-31
**Priority:** blocks the cloud half of the Security Agent (Plan 2). The local scanner ships without it.

## Why

The Security Agent scans each checkpoint's commit in the background. Its local layers (secrets, dependency advisories, sink rules) run on the user's machine. Its triage layer asks Cloudflare's Clef decision model narrow questions about each changed hunk, to decide which hunks get a deeper review. The desktop never holds a Cloudflare token, so that call has to go through the gateway, like every other model call (`GATEWAY_BASE_URL`, `crates/atlas-native-agent/src/engine/config.rs`).

Measured on Atlas's own history: about 2.5 hunks per changed file, roughly 1,750 input tokens per call, $0.24 per million input tokens (Clef bills no output). A 30-PR history cost $0.80.

## What we are asking for

1. **A forwarding route for Clef.** For example `POST /v1/decide`. It takes the body below, forwards it to Workers AI's `@cf/cloudflare/clef`, and returns Workers AI's `result` object unchanged (`answers`, `usage`). Entitlement is checked like the chat routes.

   ```json
   {
     "model": "clef",
     "state": "path: src/routes.ts\nlanguage: js/ts\n…\n--- hunk ---\n@@ -1 +1,3 @@\n+…",
     "questions": { "input_to_sink": { "type": "noul", "instructions": "…" }, "…": {} }
   }
   ```

   The exact `questions` object is `questions_json()` in `crates/atlas-security/src/clef.rs`. The route should not rewrite it: key order matters, because Clef breaks ties by option order.

2. **A background allowance separate from agent turns.** Scans are background work and must never take a user's own turn slots, or queue behind them. Roughly one call per changed hunk, in bursts after a commit. The desktop limits itself to 2 concurrent calls and backs off on `429` with `Retry-After`.

3. **Explicit size errors, never silent truncation.** Workers AI truncates an over-long `state` silently, which would judge half a hunk. The desktop already caps `state` at 48,000 characters. Please reject anything larger, or anything that would be truncated, with a `413` naming the limit.

4. **No logging of `state` bodies.** They are users' source code. Logging token counts and status is fine.

5. **Billing: metered on the organisation's Atlas credits** (decided 2026-10-31). Price Clef like any other model, with an `ai_model_price` row for `clef` at Cloudflare's rate ($0.24 per million input tokens, no output charge). Charge each call to the caller's organisation through the same entitlement and metering as chat completions, so `403 no_entitlement` and an exhausted balance behave exactly as they do for a turn. The desktop treats either as "not run", never as a pass. On the Cloudflare side, the account's prepaid AI Gateway credits can pay for these calls if the Workers AI billing on the gateway used for this route is set to **Unified billing**. As of 2026-10-31, all five gateways (`atlas`, `atlas-dev`, `default`, `tbench-new`, `tbench-old`) use `postpaid`. We suggest a dedicated gateway for this route (for example `atlas-security`) with Unified billing, so the existing gateways' billing is left as it is and scan traffic is easy to see in the gateway's logs and analytics.

6. **Optional, same or sibling route: a package-existence check.** Given `{ecosystem, name}` for crates.io, npm or PyPI, it answers whether the name exists on the public registry. The desktop uses this to catch invented package names, only under the user's cloud opt-in, and treats a lookup failure as "not run".

## The contract we will honour

- One call per hunk, plus at most one more per pair of linked hunks.
- Any failure (timeout, `5xx`, `429` after retries, `413`) is "not run" for that hunk. It never counts as a pass, and on a sensitive path it escalates.
- `usage.input_tokens` is read for our own cost tracking. Nothing else in the response is relied on beyond `answers`.

Reference: `docs/superpowers/specs/2026-10-31-security-agent-design.md` §6.3 and §10 (kept locally by the desktop team), `crates/atlas-security/src/clef.rs`.
