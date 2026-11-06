# Request to the server team: in-flight slots held after a client hang-up, and limits sized for subagents

**From:** Atlas desktop (native agent)
**To:** whoever owns `apps/ai` and `apps/auth` in `tryatlas/server`
**Date:** 2026-10-17
**Priority:** issue 1 is the one users hit. Issues 2 and 3 make it worse, and they are cheap to change.

> **Status: open.** Observed on Windows against production (`https://ai.tryatlas.cc/v1`) while testing native-agent subagents. The desktop changes involved are on the `0.4.1` branch: `dd2fd3ce` (multi-agent v2), `0fd355c2` (inter-agent mail, client concurrency lowered to 3), `d166dbf0` (Stop cascades to subagents).

## Why this matters now

The native agent can now delegate. One chat is a parent thread plus up to two child threads, and **each thread streams its own `/chat/completions` request**. A single chat therefore holds up to 3 of the 4 per-user in-flight slots by design. Before subagents it held 1. Any slot the gateway fails to give back now shows up as a broken run, where before nobody noticed.

## 1. A stream the client abandons keeps its in-flight slot until the reservation TTL

**What we see.** When the user presses Stop, the desktop drops its streaming requests: the parent's, and since `d166dbf0` each subagent's. After that, the next delegating run gets `429` on its children's requests for roughly the reservation TTL:

| UTC (2026-10-17) | Event |
|---|---|
| 05:14:23 | Run A spawns two subagents |
| 05:14:25 | Stop. Parent and both children are interrupted, and their streams are dropped mid-generation |
| 05:15:35 | Run B: the parent's requests return `200`, both children get `429 Too many requests in flight: you have 4 already running.` The engine's one retry also gets `429`, and the children die |
| 05:21:44 (+7 min) | Run C: 18 × `200`, 24 × `429`. Same pattern |
| 05:36:06 (+22 min) | Run D: 18 × `200`, **0 × `429`**. Clean |

Nothing else held slots for this user: all three runs were in one fresh app process, and the log shows only that run's threads making requests. The slots came back somewhere between 7 and 22 minutes after the hang-up. That fits `RESERVATION_TTL_MS = 15 min` reclaiming them, and it does not fit a settle on cancel.

**What the code intends.** `meterStream` (`apps/ai/src/metering.ts`) says a caller disconnecting reaches the stream's `cancel`, which calls `finish(true)`. That resolves `measured`, and `ctx.waitUntil(...)` in `apps/ai/src/index.ts` (around L1090) records the event as `aborted` and calls `settle`, which deletes the reservation row. On the evidence above that path is not running, or not finishing, for these requests.

**What to check** (we can't see production D1 or Workers logs from here):
- `ai_reservation` rows for the user around 05:14:25–05:30 UTC. Did they sit until `expires_at`?
- Usage events with status `aborted` for those requests. Was the settle continuation reached at all?
- The Workers invocation outcome for the abandoned requests: `canceled` vs `ok`, and whether `waitUntil` work was cut off.
- Whether `ReadableStream.cancel` fires at all when the downstream TCP/HTTP2 stream closes during an awaited `pull()`. The `pull` is parked on `reader.read()` from upstream. If the runtime only signals cancel between pulls, a long upstream gap could delay or lose it.

**Ask.** Settle (or `release`) the reservation when the caller goes away, reliably. If the runtime gives no dependable hook, a short TTL for *streaming* reservations that is renewed while bytes flow would bound the damage to seconds, not 15 minutes.

## 2. `MAX_CONCURRENT_PER_USER = 4` is tight for a delegating agent

`apps/ai/src/limits.ts` sets this at 4 and notes the numbers are guesses to revisit (ATL-143). The engine's own default for subagent threads per session is also 4, so one delegating chat got `429` on its *parent*. We lowered the client to 3 threads per session in `0fd355c2`. That leaves one slot of headroom per user across every chat they have open, and issue 1 eats that headroom on a single Stop.

**Ask.** Raise the per-user bound (the per-subject bound of 20 already guards an org), or count a session's subagent requests separately. The desktop can send an identifier if that helps; tell us which header.

## 3. `/api/auth/token` is behind the general Better Auth limiter

Once run C's children were retrying into `429`s, the next thread start failed to mint at 05:30:50: `/token failed: 429 Too Many Requests`, 22 times in that minute. The turn died at once with "Missing bearer token". `/api/auth/token` falls under Better Auth's general `rateLimit` (`apps/auth/src/auth.ts` ~L414: `window: 60, max: 100`), with no custom rule.

**Desktop side, for context (ours to fix, tracked separately):** the native agent's token provider caches a token until 60 s before it expires, but a *failed* mint isn't cached, so a burst of failing requests turns into a burst of mints. We will add a backoff on our side.

**Ask.** Give `/token` its own rule, sized for a desktop whose agents mint per thread, and send `Retry-After` on its `429` the way the AI gateway's concurrency `429` already does (`CONCURRENCY_RETRY_AFTER_SEC`).

## How to reproduce

1. On the `0.4.1` desktop build, choose **Atlas Agent** and send: *"Launch two subagents in parallel: one named 'counter' that counts the files in the src-tauri/src/commands directory, and one named 'greeter' that composes a one-line greeting. Report both results. Do not modify any files."*
2. Press Stop as soon as "Start subagent greeter" appears.
3. Within a minute, send the same prompt in a new chat. The children's requests get `429 Too many requests in flight`.
4. Run it again 20 minutes later. It succeeds.
