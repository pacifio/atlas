# Plan: "Let teammates drive" — the room's member tier, from the desktop and the web

Status: plan, 2026-11-01. Two halves: the desktop (pacifio/atlas#528's branch) and
the web room page (tryatlas/server#31's branch), plus one additive roster field so
the two never disagree.

## Why

Hand-over exists end to end except for one switch. The server (tryatlas/server#31)
already takes `PATCH /rc/rooms/{id} { memberTier }` and, on a change, re-badges every
member socket, returns the seat to the owner if the new tier no longer steers, and
sends the roster (`rc-do.ts` `settings()`). The web viewer already shows **Ask to
drive**, **Allow / Decline**, **Hand control to …**, **Hand back** and **Take over**
once a member's tier allows `submit`. But the desktop creates every room with
`member_tier: Some(Tier::View)` (`src-tauri/src/commands/rc.rs` ~334) and has no
command or control to change it, so invited teammates are stuck watching — which is
what the web panel's footer says: "set the member tier on your desktop".

## Decisions

1. **One checkbox, two tiers.** "Let teammates drive" toggles `view` ↔ `steer`.
   `steer_approve` (members may also answer permission prompts) stays the owner's;
   per the scope rule the owner stays master. A three-way picker can come later —
   the command takes the tier, not a bool, so nothing is re-wired for it.
2. **Per room, opt-in, not remembered.** Every room still opens at `view`; the owner
   turns driving on for this room. A remembered preference is a later slice.
3. **Shown only for a shared room.** A solo room (`scope === null`) has nobody to
   invite, so the item does not appear; it appears after "Share with <org>".
4. **The room tells both ends the tier.** Today the host socket never learns it
   (nothing in `host.rs` / `wire.rs` reads `memberTier`), so a change made on the
   web would leave the desktop's checkbox stale. Fix: `rc.roster` (full) gains an
   additive `memberTier`, sent on every roster — the server already sends a roster
   right after a tier change (`settings()` → `markRosterDirty`). Each peer's `tier`
   is already on the roster, but only for people connected now, so it is not enough
   on its own. The desktop takes the tier from the roster; the PATCH response is
   only confirmation.

## Changes

### Server — the roster carries the tier (tryatlas/server, `feat/universal-rc`)
- `packages/contracts/src/rc.ts` `RcRosterFull`: add `memberTier: RcTier` (strict
  object, so both fixtures `rc-frames-v1.json` get the field). Guest rosters need it
  not: a link visitor has no tier to raise.
- `apps/ingest/src/rc-do.ts` where the full roster is built: `memberTier:
  this.room.member_tier`. The existing roster tests pin the shape; extend one with
  the field.

### Web — the switch on the room page (tryatlas/server, `feat/universal-rc`)
- `apps/web/src/features/rc/rc-seat.tsx`, the owner's `InvitePanel`: replace the
  footer sentence with the page's own `Switch` (`components/ui/switch.tsx`),
  labelled **Let teammates drive**, checked when `room.memberTier !== 'view'`,
  disabled while the mutation is pending; keep a one-line hint under it ("Teammates
  can ask to drive, and you can hand control to one" / "Teammates can watch").
- `apps/web/src/lib/queries/rc.ts`: a `useSetRcMemberTier(roomId)` mutation —
  `PATCH /api/rc/rooms/{roomId}` with `{ memberTier }` through the RC proxy (PATCH on
  a room is already allow-listed and Origin-checked, `rc-proxy.ts:83`), then
  invalidate `rcKeys.room(roomId)`. Same shape as the invite / uninvite mutations
  beside it.
- Nothing else: the seat bar and `PeerActions` already read each peer's tier off the
  live roster, so **Ask to drive** and 🛞 appear on the next roster the server sends.
- Test: `rc-seat` test — the switch is the owner's only; toggling calls the PATCH
  with `steer`, then `view`.

### Rust — `src-tauri/src/commands/rc.rs`
- `RcRoomWire`: add `pub member_tier: Tier` (serialises `"view" | "steer" |
  "steer_approve"`, `rename_all = "camelCase"` is already on the struct). Set it from
  the `CreateRoomRequest` in `rc_start` (and on the replace-an-ended-room path) and
  in `rc_status`'s source.
- New command, modelled on `rc_set_scope`:
  ```rust
  #[tauri::command]
  pub async fn rc_set_member_tier(session_id: String, tier: Tier, app: AppHandle, rc: State<'_, RcState>) -> Result<Tier, String>
  ```
  Looks the room up (same error text as `rc_set_scope` when there is none), refuses
  on a solo room ("Share the room with an organisation first."), calls
  `client.update_room(&room_id, &UpdateRoomRequest { member_tier: Some(tier), ..Default::default() })`,
  then writes `room.wire.member_tier = tier`, `emit(&app, &wire)`, returns the tier.
  No-op (return current) when unchanged.
- `src-tauri/src/lib.rs`: add `commands::rc::rc_set_member_tier` to the
  `generate_handler![]` list beside `rc_set_scope` (~759).
- Seat consequences need no desktop code: lowering to `view` while a member drives
  makes the server return the seat; the roster that follows reaches `on_status`,
  which already clears the remote driver.
- `crates/atlas-remote-control/src/wire.rs` `RosterFull`: add `member_tier: Tier`
  (`#[serde(default)]` so an older server still parses); `host.rs` copies it onto
  `HostStatus`; `on_status` writes `room.wire.member_tier` from it. A change made on
  the web then reaches the desktop's checkbox on the same roster that re-badges the
  members. The fixture parity test (`crates/atlas-remote-control/tests/fixtures`
  ↔ `packages/contracts/fixtures`) must be updated on both sides together.

### TypeScript — `src/features/chat/lib/rc-api.ts`
- `export type RcTier = "view" | "steer" | "steer_approve";`
- `RcRoom`: add `memberTier: RcTier;` (`wire-shape-contract` holds it field-for-field
  against `RcRoomWire`).
- `rc.setMemberTier: (sessionId, tier: RcTier) => invoke<RcTier>("rc_set_member_tier", { sessionId, tier })`.

### Hook — `src/features/chat/lib/use-remote-control.ts`
- `membersDrive: boolean` (`room.memberTier !== "view"`), and
  `setMembersDrive(on: boolean)` → `rc.setMemberTier(sessionId, on ? "steer" : "view")`
  under the existing `busy` guard; `toast.success("Teammates can drive" / "Teammates
  can watch")`, `toast.error(errInfo(e).message)` on failure.

### UI — `src/features/chat/components/rc-header-menu.tsx`
- In the open-room branch, after the Share item and before the separator:
  ```tsx
  {room.scope && (
    <DropdownMenuCheckboxItem checked={remote.membersDrive} onCheckedChange={remote.setMembersDrive} disabled={remote.busy}>
      Let teammates drive
    </DropdownMenuCheckboxItem>
  )}
  ```
  `DropdownMenuCheckboxItem` is the primitive's own (used by the pull-request
  filters); no className, no new pattern. Update the file's header comment.

### Mock backend — `src/dev/mock-backend/fixtures/rc.ts`
- `RcResponses.rc_set_member_tier: RcTier`; handler sets `room.memberTier` and
  `announce(room)`; the `rc_start` room literal gets `memberTier: "view"`.
  (`mock-backend-contract` requires a fake for every invoked command.)

### Test fixtures that build an `RcRoom` literal (now need `memberTier`)
`rc-driver-bar.test.tsx`, `rc-header-menu.test.tsx`, `remote-control-section.test.tsx`,
`session-header-order.test.tsx`, `rc-store.test.ts` (if it builds rooms).

## Tests
- `rc-header-menu.test.tsx`: no item on a solo room; present once `scope` is set;
  reflects `memberTier` (unchecked at `view`, checked at `steer`); clicking invokes
  `rc_set_member_tier { sessionId, tier: "steer" }`, and again `"view"` when checked.
- `crates/atlas-remote-control/src/rest.rs`: if `update_room` has a scope PATCH test,
  add the sibling asserting the body is exactly `{"memberTier":"steer"}`.
- Contracts run as they are: `wire-shape-contract` (new field), `ipc-contract` (new
  command has a frontend caller and one registration), `mock-backend-contract`,
  `rc-fixture-parity`.

## Verify
```bash
bun run typecheck && bun run lint && bun run format:check
bun run test src/features/chat tests/wire-shape-contract.test.ts tests/ipc-contract.test.ts tests/mock-backend-contract.test.ts tests/rc-fixture-parity.test.ts
cargo check -p atlas && cargo test -p atlas-remote-control
```
Then in a window against the local server (`docs/research/rc-merge-0.4.1-plan.md`
has the setup): share a room, tick **Let teammates drive**, and the web room page
shows the 🛞 **Hand control to …** buttons in "Here now" and **Ask to drive** for a
teammate; untick while a teammate drives and the seat returns to you.

## Order
1. Server: contract field + roster emit + fixtures (both repos' fixture copies).
2. Desktop: wire/host/status, then the command, the hook and the checkbox.
3. Web: the mutation and the switch.
Either UI half works alone once step 1 is in; without step 1 the desktop checkbox
can go stale after a change on the web.

## Out of scope
Remembering the preference across rooms; `steer_approve`.
