# Universal RC: one room per session — reopen, hide ended, delete

> **Status: built 2026-11-02, not yet run live.** Decisions settled with the user
> in conversation the same day; O1–O3 resolved as recommended (7-day purge kept,
> delete is owner-only, `member_tier` kept on reopen). Server half (uncommitted,
> `~/Codes/server`): migration `0046_rc_room_per_session`, create-door reopen,
> object `/reopen` + `/delete`, list = open only, `DELETE /rc/rooms/{id}` and
> `DELETE /rc/sessions/{id}/room`, `deleted` end reason, web delete action —
> `apps/ingest` RC suites 189/189. Desktop half (this branch): `Deleted` wire
> variant + fixture, `rc_delete`, `rc_set_title` (the hook sends the title on
> change), "Delete room…" in the header menu behind `confirm()`, mock fakes —
> light gates green. Left: the manual matrix below against a deployed server.
> Pre-existing, not from this change: `tests/rc-fixture-parity.test.ts` already
> fails because the desktop's `rc-frames-v1.json` carries a `memberTier` roster
> field the `~/Codes/server` checkout's contract does not (the #32 drift).
> Follows the merge plan in `rc-merge-0.4.1-plan.md`; the seam survey is
> `universal-rc-seam.md`.

## The report

Start RC on a session, stop it, start it again: the web list shows a new "Ended"
room each time — three rows for one session, one of them titled "New session"
because the first start happened before the session was titled.

## Why (as built)

A room today is one *broadcast*, not a session:

- The only identity rule is `(owner_user_id, session_id)` unique **while open**
  — `packages/db/migrations/0045_rc_rooms.sql:47`, `packages/db/src/schema.ts:2311`.
  Ended rooms for the same session accumulate.
- `rc_stop` closes the room for good: `src-tauri/src/commands/rc.rs:518-530` →
  `POST /rc/rooms/{id}/close` (`apps/ingest/src/rc.ts:659`). The next `rc_start`
  hits `POST /rc/rooms` (`rc.rs:348`); the create door finds no *open* room
  (`rc.ts:369`, `openRoomFor` at `rc.ts:461`) and inserts a fresh row, fresh id,
  fresh viewer URL, fresh host secret.
- `GET /rc/rooms` returns every row, open first (`rc.ts:538-549`); the web list only
  groups by Organisation (`apps/web/src/routes/_app/rc.index.tsx:137`).
- The title is snapshotted into the row at create (`rc.rs:329-339`, `rc.ts:439`) and
  never updated; the `PATCH` title door exists (`rc.ts:586`) but the desktop never
  sends it.
- Ended rooms are purged by the room object after `RC_ROOM_RETENTION_MS` (7 days,
  `packages/contracts/src/rc.ts:238`; `rc-do.ts:2112`, `purge()` at `rc-do.ts:2150`),
  at once for `erased`.

## Decisions (settled 2026-11-02)

| # | decision |
|---|----------|
| D1 | **A room's identity is the session.** One room per `(owner, session)`, for the session's life. Same room id and viewer link on every start. |
| D2 | **Stop closes the room and keeps nothing.** The room page shows "ended" and nothing else; the room is not listed. |
| D3 | **Start reopens the same room.** No new room for a session that has one. |
| D4 | **No replay across broadcasts.** The room holds no history from a previous broadcast. *Unchanged:* a viewer joining a live room still gets the session's current snapshot from the desktop (`crates/atlas-remote-control/src/host.rs:9-15`) — that is the live session as the desktop shows it, not RC history. |
| D5 | **The title follows the session.** Rename on the desktop → `PATCH` title on the room. |
| D6 | **Invited members survive a stop.** Removing someone is deliberate (kick / revoke), never a side effect of stop. |
| D7 | **Delete exists, and is hard.** Delete removes the room, its members, and the object's state; the old link answers "no such room". Allowed while live (viewers get a `deleted` end reason). The next start on that session creates a brand-new room: new id, new link, no members. |

Stop vs delete, in one line: stop closes the door (house stays, same address,
same invite list); delete demolishes the house.

## Design

### Server (`~/Codes/server`)

**S1 — identity.** Replace the partial unique index with an unconditional one:
`rc_rooms_session` on `(owner_user_id, session_id)`. Migration `0046`: first
collapse existing duplicates (keep the open row if any, else the newest; delete
the rest — they are ended rooms nobody can reopen anyway), then swap the index.
Keep the `status IN ('open','ended')` check; no new status.

**S2 — create door reopens** (`rc.ts:349`). After the platform gate:

1. open room for `(caller, sessionId)` → `200`, `hostSecret: null` (as now).
2. **ended room** for the pair (not yet purged) → **reopen**: new host secret,
   `UPDATE rc_rooms SET status='open', ended_at=NULL, end_reason=NULL, purge_at=NULL,
   owner_client_id, agent, model, capabilities, title` from the request; tell the
   object `POST https://rc/reopen` (new handler, below). Answer `201` with the
   secret — the secret-only-in-the-`201` rule holds, since the old one died with
   the old process. `member_tier`, `org_id`/`workspace_id` and `rc_members` are
   **kept** (D6; scope is set-once already).
3. none → create, as now. The open-rooms-per-account limit applies to 2 and 3.

The desktop's "open room from an earlier run, secret lost → close + create"
branch (`rc.rs:360-370`) needs **no change**: close then create now reopens the
same id. Keep it.

**S3 — room object `/reopen`** (`rc-do.ts`, beside `init` at `:592`). Refuse
unless `status = 'ended'` (`409 rc_closed` otherwise). Set `status='open'`,
`host_secret_hash`, `owner_client_id`, `capabilities`, `agent`, `model`,
`driver_id = owner`, `driver_kind='user'`, `driver_epoch += 1`,
`host_first_hello_by = now + RC_HOST_FIRST_HELLO_MS`, clear `owner_offline_at`,
`ended_at`, `end_reason`, `purge_at`. The tail, snapshot and command tables were
already emptied at end (`rc-do.ts:2124-2126`) — D4 is free. Kicked/revoked
memory stays. Audit `room_reopened`. Re-arm the alarm (first-hello deadline).

**S4 — list is open rooms only** (`rc.ts:538`). Add `AND status = 'open'`; drop
the `CASE status` ordering. `GET /rc/rooms/{id}` keeps answering an ended room so
the page can say why (`rc.rooms.$roomId.tsx:122`), until purge turns it `404`.

**S5 — delete.** Two doors onto one function:

- `DELETE /rc/rooms/{id}` — owner only (`403 rc_not_owner`; an admin may close,
  not delete). Web uses it.
- `DELETE /rc/sessions/{sessionId}/room` — the caller's room for that session,
  open or ended. Desktop uses it, because after a stop (or an app restart) the
  desktop no longer holds the room id.

Behaviour: if open, close via the object with reason **`deleted`**; then purge now
— the `erased` path already does "purge at once" (`rc-do.ts:2112`), so `deleted`
joins it. Members rows and the row go in the object's `purge()`; `204`. Idempotent
(`204` when there is nothing).

**S6 — `deleted` end reason.** Add to `RC_END_REASONS`
(`packages/contracts/src/rc.ts:90`). Web copy: "The owner deleted this room."
Additive on the wire; the desktop side is A2.

**S7 — title.** No server work; `PATCH /rc/rooms/{id} { title }` exists.

**S8 — retention.** Ended rooms still purge after 7 days (`rc-do.ts:2112`). A
session not restarted for a week therefore gets a *new* room on its next start.
See O1.

**Tests:** `apps/ingest/test/rc-rooms.test.ts` (reopen keeps id/members/scope,
issues a new secret, list hides ended, delete → `404` and next create is a new
id, non-owner delete `403`), `rc-retention.test.ts` (`deleted` purges at once),
`rc-wire.test.ts` / fixtures (new end reason). Update the migration snapshot.

### Desktop (`~/Codes/atlas`)

**A1 — `rc_start`:** unchanged. The create door's answer is now the session's
room. Keep the secret-lost branch (`rc.rs:360-370`).

**A2 — wire:** `Deleted => "deleted"` in the `EndReason` `wire_enum!`
(`crates/atlas-remote-control/src/wire.rs:102-112`) and the shared fixture under `crates/atlas-remote-control/tests/fixtures/`;
`tests/contract.rs:191` (`same_enum!`) and `tests/rc-fixture-parity.test.ts`
enforce parity with the server's list. TS `RcEndReason` in `rc-api.ts`.

**A3 — `rc_delete(sessionId)`** command in `src-tauri/src/commands/rc.rs`: if the
session has a live room, `stop_room`-style teardown (handle stop, release the
hold, tap) *without* the close call; then `DELETE /rc/sessions/{sessionId}/room`
through a new `RcClient::delete_session_room` in
`crates/atlas-remote-control/src/rest.rs`. Emit the wire as `ended` with
`end_reason: deleted`, then drop it from the store's ended set so the header
indicator clears. Register in `commands/mod.rs` / `generate_handler![]`; wrapper
in `src/features/chat/lib/rc-api.ts`; `tests/ipc-contract.test.ts` and
`src/features/chat/components/rc-header-menu.test.tsx`.

**A4 — title follows the session.** *As built:* the window already computes
the display title (`sessionDisplayTitle`, the same value `rc_start` is given),
so the hook `useRemoteControl(sessionId, title)` sends `rc_set_title` whenever
`title` changes while the room stands — rename and the agent's auto-title both
flow through it. `rc_set_title` PATCHes the room's title; best-effort, nothing
without a room. (The Rust-side hook at `rename_thread` was not needed.)

**A5 — UI.** `rc-header-menu.tsx`: add "Delete room…" below "Stop remote
control", shown whenever the store knows a room for the session (live *or*
ended), behind `src/components/confirm-dialog.tsx` (the message names how many people
are connected when live). `rc-store.ts` already keeps an ended room until the
next start (`:6-7`); the delete action removes it. Hint copy for
`deleted`. No new visual pattern.

**A6 — session end.** The session-end hook (`rc.rs:267-280`) still *stops*, not
deletes: the room survives for the next start.

### Web (`~/Codes/server/apps/web`)

**W1 — list.** Nothing arrives ended any more; the "Ended" badge branch in
`rc.index.tsx:131` can stay as a dead-safe default.

**W2 — room page.** `END_REASON.deleted` copy; a "Delete room" action for the
owner (confirm), calling `deleteRcRoom(roomId)` from `lib/rc.ts`, invalidating
`rcKeys.rooms()`, then navigating to the list. After purge the existing
`404` copy ("may have ended and been cleared") is already right.

## Order of work

1. Server: contract (`deleted`), schema + migration 0046, create-door reopen,
   object `/reopen`, list filter, delete doors, tests. One PR on the server repo.
2. Desktop: wire enum + fixture + contract tests (parity with 1), `rc_delete`,
   title PATCH, header menu. Lands on `feat/universal-rc-0.4.1` (PR #528 line).
3. Web: `deleted` copy + delete action.
4. Manual matrix, `bun run dev:app` against the deployed server.

The desktop builds against the server's contract, so 1 ships first; the desktop
change is additive on the wire and safe against an old server (an old create door
simply makes a new room, as today).

## Manual matrix

| step | expect |
|------|--------|
| start → stop → start, same session | same room id and link; the list shows one row, live |
| stop | list empty; the room page says ended, no transcript |
| rename the session while live | the row's title changes |
| start before the session is titled, then it gets a title | row shows the title |
| invite someone, stop, start | they are still a member, their link still opens |
| delete while live, viewer on the page | viewer sees "The owner deleted this room."; desktop header says deleted, then clears |
| start after delete | new room id, new link, no members |
| quit the app with a live room, relaunch, start | same room id (close + reopen path) |
| open the old link after delete | "no such room" |

## Open

- **O1 — retention.** Keep the 7-day purge of ended rooms (bounded storage; a
  room idle a week gets a new id on its next start), or purge only on delete /
  session erasure (links stable forever, rows forever)? Recommendation: keep the
  purge for now; it is the existing behaviour and the desktop already handles
  "no room → create".
- **O2 — admin delete.** An Organisation admin may close a room today. Delete is
  owner-only in this plan. Confirm.
- **O3 — `member_tier` on reopen.** Kept from the room (D6 spirit), not reset to
  the desktop's `View` default. Confirm.
