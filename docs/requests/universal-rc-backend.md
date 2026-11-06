# Universal Remote Control: backend implementation specification

**From:** Atlas desktop (Universal RC, ATL-964)
**To:** whoever owns `apps/ingest`, `apps/web`, `packages/contracts`, `packages/db` and `packages/do-protocol` in `tryatlas/server`
**Date:** 2026-10-26
**Priority:** the desktop side is built and tested against exactly this; nothing here is optional.

> **Status: specified from a working reference.** Every rule below was taken from
> a complete, passing implementation on the server branch `feat/universal-rc`
> (49 ingest test files, 684 tests; 98 web files, 1055 tests; the desktop's
> wire fixtures are byte-identical to the server's). This document is written so
> that it can be implemented, reviewed or re-implemented **without reading that
> branch and without making a single decision**: every name, value, order of
> checks, status code, close code and error string is stated. Where this
> document and any older plan disagree, this document wins.

## How to read this document

- Part A (sections 1–7) is the outside of the feature: contracts, storage, the
  REST doors, the two socket doors, the web proxy, and what Organisation events
  do to a room.
- Part B (sections 8–11) is the inside: the room Durable Object, the host's
  half of the protocol, the acceptance tests and the operational wiring.
- Code blocks are verbatim and are the contract. Tables carry every number.
  Numbered lists are orders of execution; a check must run in that order
  because an earlier failure decides the response.
- "Owner" always means the account whose `sub` created the room. "Organisation"
  only ever means the room's **scope**, never the caller's query string.
- A line beginning *Reference implementation:* names the file in
  `feat/universal-rc` that embodies the section. It is a pointer for reviewers,
  not an input: the text above it is complete on its own.

## Reference implementation map

| area | file |
| --- | --- |
| contracts, fixtures | `packages/contracts/src/rc.ts`, `packages/contracts/fixtures/rc-frames-v1.json`, `packages/contracts/fixtures/rc-wire-v1.json` |
| feature catalogue entry | `packages/contracts/src/features.ts` |
| error codes | `packages/contracts/src/workspaces.ts` |
| D1 schema | `packages/db/migrations/0045_rc_rooms.sql`, `packages/db/migrations/meta/0045_snapshot.json`, `packages/db/src/schema.ts` |
| REST and socket doors | `apps/ingest/src/rc.ts` |
| room object | `apps/ingest/src/rc-do.ts` |
| object names | `apps/ingest/src/rc-names.ts` |
| Organisation events, erasure | `apps/ingest/src/rc-revoke.ts`, `apps/ingest/src/org-events.ts`, `apps/ingest/src/erase.ts` |
| subject-only socket authorisation | `packages/do-protocol/src/upgrade.ts` |
| web proxy and routes | `apps/web/src/lib/rc-proxy.ts`, `apps/web/src/server.ts`, `apps/web/src/lib/document-headers.ts`, `apps/web/src/routes/_app/rc.index.tsx`, `apps/web/src/routes/_app/rc.rooms.$roomId.tsx` |
| tests | `apps/ingest/test/rc-*.test.ts`, `apps/ingest/test/rc-client.ts`, `apps/web/src/lib/rc-proxy.test.ts`, `apps/web/src/lib/use-rc-room.test.tsx`, `apps/web/src/features/rc/rc-controls.test.tsx`, `packages/do-protocol/test/upgrade.test.ts` |

## 1. Scope, requirements and vocabulary

Universal Remote Control lets one desktop emit a live agent session and lets the same person watch and steer it from a browser, a phone or another desktop. The desktop opens an **RC room** for one Session, holds the room's one **host socket**, and streams its seq-stamped `SessionDelta` envelopes up to a Durable Object in `atlas-ingest`; the object relays every frame to every **client socket** before it stores anything, keeps a byte-bounded tail and the host's latest snapshot so a late joiner is served snapshot-then-tail, and relays steering commands down to the host and the host's answers back. The object never parses a stream payload, never runs an agent, and never queues a command while the desktop is offline. A room belongs to an **account**: `rc_rooms.owner_user_id` is the creating token's `sub`, and that account alone may open, host, list, read, manage and close the room from any surface. No Organisation is consulted for any of this; a token whose `orgs` claim is `{}` is sufficient.

Multiplayer is optional and scoped. A room's **scope** is a nullable, set-once pair `(org_id, workspace_id | null)`: the Organisation (and, when the project is cloud-bound to it, the Workspace) whose people the owner may invite. `NULL` is a **solo room**. The scope is sent at creation or set once later by `PATCH`, and it is *revoked* — members cut, pair back to `NULL`, room continues solo — when the owner leaves the Organisation or the Organisation is deleted. Exactly one person **drives** at a time: the driver seat starts with the owner at epoch 1, every change of driver advances the epoch, and while somebody else holds the seat the owner's own steering commands are refused `not_driver` (with a take-over hint). The owner's master powers — stop, kick, take over, grant, close — are never gated by the seat.

### 1.1 Requirements

| # | requirement |
| --- | --- |
| R1 | **RC is personal first.** A room belongs to the account that owns the desktop. A developer with no Organisation members, or no Organisation at all, uses it fully: agent on the laptop, prompting from the phone, signed in as themselves. |
| R2 | **Any agent.** Every installed ACP agent and the native Atlas Agent. Capability is advertised by the desktop (`capabilities`), never assumed from which agent it is. |
| R3 | **Multiplayer is optional and Organisation + project scoped.** With a specific Organisation and project selected in the app, the owner may invite only people of that Organisation, in that project's scope. Nobody else. |
| R4 | **Single driver.** Exactly one person can prompt at a time. After handing steering to A, only A can prompt — the owner cannot — until the owner takes it back. The owner stays master: take over, kick, close. Visitors watch and ask; the driver or owner approves. |
| R5 | **Public links** (optionally password-protected) are subordinate: they must never force an Organisation onto solo use. (Not built in this cut; see §1.3.) |

### 1.2 Glossary

| term | meaning |
| --- | --- |
| room | One remotely-controlled live desktop Session, hosted by one `RcRoomDurableObject` named `rc:{roomId}`, with one directory row in D1 `rc_rooms`. |
| owner | The account (`claims.sub`) whose desktop created the room; written out as *room owner*; the master on every surface, `steer_approve` everywhere, and the default driver. |
| host | The owner's desktop on `/rc/host/ws`: the one socket per room that may send stream frames and command results, admitted as host only once its hello presents the host secret. |
| client | Any socket on `/rc/ws`: the owner on another surface (role `owner`) or an invited member (role `member`). |
| principal | Who a socket is: a signed-in `user` (id = user id), a named link `guest` (`guest:{hex}`) or an unnamed `link` holder (`link:{linkId}`); set by the object from the socket, never from a frame. Only `user` exists in this cut. |
| scope | The room's nullable, set-once `(orgId, workspaceId \| null)`: whom the owner may invite and whose link policy applies; `NULL` = solo room. |
| seat / driver / epoch | The driver seat is held by one *person*; the driver is that principal; the driver epoch is an integer starting at 1 that advances on every change of driver, and every command names the epoch it was issued under. |
| tier | What a principal may do: `view` (watch), `steer` (also prompt, stop, model, non-widening mode while driving), `steer_approve` (also answer permission and elicitation prompts; members only). Server-derived, never client-named. |
| surface | Where a client socket is drawn — `web`, `mobile` or `desktop`; informational, for the roster. |
| ring / tail | The object's in-memory buffer of whole stream frames in seq order, bounded by the `rc_tail_bytes` limit, checkpointed to the object's SQLite; the tail is what a reconnecting client is served from. |
| seq | The desktop-assigned, dense (from 1) per-Session sequence number on every delta envelope; `seqFirst`/`count` on a batch frame, `since` on a client hello, `head` on a welcome. |
| snapshot | The host's serialisation of the whole session as of one seq, sent in parts of at most `RC_SNAPSHOT_PART_MAX_BYTES`, stored by the object and served to a joiner whose `since` is below the tail. |
| host secret | 32 random bytes (64 hex) returned once in the `201` of `POST /rc/rooms`; the object stores only its SHA-256 and compares the host hello's copy against it. |
| ticket | The short-lived access JWT a socket carries in `Sec-WebSocket-Protocol` as `atlas.ticket.<jwt>`, verified against the JWKS; it proves `sub` and nothing about an Organisation. |

### 1.3 Not in this cut

The following exist only as placeholders so that later slices add doors without changing the contract:

- **Invites door.** No door writes `rc_members`. The table, the `isInvited` read on the dial and REST doors, `RcMember`, `RcRoomResponse.members`, and the member dial path are built and tested by writing rows directly. `rc_members.joined_at` and `rc_members.emailed_at` are never written. The error code `rc_no_scope` is registered and never returned.
- **Links, public door, Turnstile, password.** Constants `RC_LINK_TIERS`, `RC_PASSWORD_MAX_FAILURES`, `RC_PASSWORD_FAILURE_WINDOW_MS`, `RC_LINK_TOKEN_TTL_MS`, `RC_TICKET_SUBPROTOCOL_PREFIX` and the limit key `rc_links` are declared and unused. The headers `X-Atlas-Rc-Link`, `X-Atlas-Rc-Tier`, `X-Atlas-Rc-Link-Expires`, `X-Atlas-Rc-Token-Key`, `X-Atlas-Rc-Guest` are stripped by every door and set by none. `RcFeaturesResponse.publicLinks` and `passwordRequired` are hardcoded `false`; `turnstileConfigured` is computed. Refusal codes `identity_required`, `link_expired`, `command_unknown`, `request_closed` are registered and never sent. Gates `org_policy`, `link_revoked`, `link_expired`, `member_removed`, `owner_only`, `option_standing`, `widening`, `in_flight`, `not_pending` are registered; the relay never refuses with them (the last five are desktop-side gates the relay only forwards in `rc.command_result`). Audit events `link_created`, `link_revoked`, `password_set`, `password_cleared`, `password_locked`, `invite_sent`, `invite_removed`, `member_joined`, `link_visitor_revoked` are registered and never recorded. The web proxy forwards `/public/links/*`, `/invites`, `/rooms/{id}/links…`, `/rooms/{id}/invites…`, `/rooms/{id}/members` and `/rooms/{id}/audit`; ingest answers every one of them `404 not_found` "no such route".
- **Audit read door.** `RcAuditEntry` is declared; the object records audit rows in its own SQLite; no door reads them.

*Reference implementation:* `packages/contracts/src/rc.ts`, `apps/ingest/src/rc.ts`.

## 2. Contracts (`packages/contracts/src/rc.ts`)

One module, exported from `packages/contracts/src/index.ts` with `export * from "./rc";`, importing only `zod`, `type FeatureLimitKey` from `./features` and `readVarint`, `writeVarint` from `./threads`. It must import nothing Workers-only: the browser bundle reads it as it is. The varint helpers it builds on are already in `./threads`:

```ts
export function writeVarint(out: Array<number>, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varint out of range: ${value}`);
  }
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

/**
 * Read one unsigned LEB128 varint at `at.i`, advancing it; `null` when the
 * bytes run out, the varint runs past 8 bytes, or the value is past
 * `Number.MAX_SAFE_INTEGER`.
 */
export function readVarint(bytes: Uint8Array, at: { i: number }): number | null {
  let result = 0;
  let scale = 1;
  for (let n = 0; n < 8; n++) {
    if (at.i >= bytes.length) return null;
    const byte = bytes[at.i++]!;
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return Number.isSafeInteger(result) ? result : null;
    scale *= 0x80;
  }
  return null;
}
```

### 2.1 Vocabulary

```ts
export const RC_PROTOCOL_VERSION = 1 as const;

export const RC_TIERS = ["view", "steer", "steer_approve"] as const;
export const RcTier = z.enum(RC_TIERS);
export type RcTier = (typeof RC_TIERS)[number];

/** The tiers an RC link may carry (`steer_approve` is unrepresentable on one). */
export const RC_LINK_TIERS = ["view", "steer"] as const;
export type RcLinkTier = (typeof RC_LINK_TIERS)[number];

export const RC_CAPABILITIES = ["steer", "approve", "mode", "model", "config"] as const;
export const RcCapability = z.enum(RC_CAPABILITIES);
export type RcCapability = (typeof RC_CAPABILITIES)[number];

/** Where a client socket is drawn. Informational, for the roster. */
export const RC_SURFACES = ["web", "mobile", "desktop"] as const;
export type RcSurface = (typeof RC_SURFACES)[number];

export const RC_PRINCIPAL_KINDS = ["user", "guest", "link"] as const;
export type RcPrincipalKind = (typeof RC_PRINCIPAL_KINDS)[number];

export const RC_ROOM_STATUSES = ["open", "ended"] as const;
export type RcRoomStatus = (typeof RC_ROOM_STATUSES)[number];

export const RC_END_REASONS = [
  "closed_by_owner",
  "closed_by_admin",
  "owner_timeout",
  "never_hosted",
  "erased",
  "retention",
] as const;
export const RcEndReason = z.enum(RC_END_REASONS);
export type RcEndReason = (typeof RC_END_REASONS)[number];

/** A client socket's standing in the room, as `rc.welcome` names it. */
export const RC_CLIENT_ROLES = ["owner", "member", "link"] as const;
export type RcClientRole = (typeof RC_CLIENT_ROLES)[number];

/** A peer's place in the roster. */
export const RC_ROSTER_ROLES = ["owner", "driver", "visitor"] as const;
export type RcRosterRole = (typeof RC_ROSTER_ROLES)[number];

export const RcClientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "8–64 of A–Z a–z 0–9 _ -");

/** A command id: a ULID, unique per sending client. */
export const RcCommandId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "a ULID");
```

| export | meaning |
| --- | --- |
| `RC_PROTOCOL_VERSION` | `1`; the first byte of every binary frame and the `protocol` of every hello and welcome. |
| `RC_TIERS` | Ordered: `view` < `steer` < `steer_approve`. The room owner is `steer_approve` on every surface. |
| `RC_LINK_TIERS` | What a link may carry; unused in this cut. |
| `RC_CAPABILITIES` | What the desktop says it will honour: `steer` (prompt/stop), `approve` (answer permissions), `mode`, `model`, `config`. |
| `RC_SURFACES` | Roster display only. |
| `RC_PRINCIPAL_KINDS` | `user` only in this cut. |
| `RC_ROOM_STATUSES` | The two directory states. |
| `RC_END_REASONS` | Why a room ended: owner close, admin close, the owner-offline grace ran out, the host never said hello within 60 s, the Session was erased, or retention. Losing the Organisation is deliberately **not** on the list — it revokes the scope, never ends the room. |
| `RC_CLIENT_ROLES` | `owner` (the owner on a client socket), `member` (invited), `link` (unused). |
| `RC_ROSTER_ROLES` | The owner, the current driver, everybody else. |
| `RcClientId` | Letters, digits, `_`, `-`; 8 to 64 characters. The same rule as `ThreadClientId`. |
| `RcCommandId` | A 26-character Crockford ULID. |

### 2.2 Limits and constants

```ts
const KiB = 1024;
const MiB = 1024 * KiB;

export type RcLimitKey = Extract<
  FeatureLimitKey,
  "rc_rooms" | "rc_participants" | "rc_links" | "rc_tail_bytes" | "rc_offline_grace_ms" | "rc_command_burst"
>;
export const RC_LIMIT_KEYS: ReadonlyArray<RcLimitKey> = [
  "rc_rooms",
  "rc_participants",
  "rc_links",
  "rc_tail_bytes",
  "rc_offline_grace_ms",
  "rc_command_burst",
];
export type RcLimits = Record<RcLimitKey, number>;
/** The same, as the create door hands it to the room's object: every key, a number. */
export const RcLimits = z
  .object(Object.fromEntries(RC_LIMIT_KEYS.map((key) => [key, z.number().int().nonnegative()])) as Record<RcLimitKey, z.ZodNumber>)
  .strict();

export const RC_SOCKETS_MAX = 64;
export const RC_SOCKETS_PER_PRINCIPAL = 4;
export const RC_ROOM_INFLIGHT_BYTES = 16 * MiB;
export const RC_VIEWER_LAG_BYTES = 2 * MiB;
export const RC_VIEWER_LAG_MS = 10_000;
export const RC_DELTA_MAX_BYTES = 256 * KiB;
export const RC_FRAME_HEADER_MAX_BYTES = 3 + 8 + 8;
export const RC_SNAPSHOT_PART_MAX_BYTES = RC_DELTA_MAX_BYTES - RC_FRAME_HEADER_MAX_BYTES;
export const RC_SNAPSHOT_MAX_BYTES = 1 * MiB;
export const RC_REHELLO_MAX = 3;
export const RC_REHELLO_WINDOW_MS = 60_000;
export const RC_HOST_PING_MS = 15_000;
export const RC_HOST_SILENT_MS = 45_000;
export const RC_HOST_SWEEP_MS = 15_000;
export const RC_CLIENT_PING_MS = 25_000;
export const RC_CLIENT_SILENT_MS = 120_000;
export const RC_HELLO_TIMEOUT_MS = 10_000;
export const RC_COALESCE_MS = 33;
export const RC_COALESCE_BYTES = 8 * KiB;
export const RC_CHECKPOINT_DEBOUNCE_MS = 1_000;
export const RC_CHECKPOINT_MAX_MS = 30_000;
export const RC_COMMAND_TIMEOUT_MS = 30_000;
export const RC_COMMAND_PER_SECOND = 2;
export const RC_COMMANDS_KEPT = 500;
export const RC_PROMPT_MAX = 32 * KiB;
export const RC_COMMAND_FRAME_MAX_BYTES = RC_PROMPT_MAX + 4 * KiB;
export const RC_COMMAND_VALUE_MAX_BYTES = 8 * KiB;
export const RC_CONTROL_MAX_BYTES = 4 * KiB;
export const RC_ACK_MAX_PER_SECOND = 10;
export const RC_HOST_FIRST_HELLO_MS = 60_000;
export const RC_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000;
export const RC_SNAPSHOT_MIN_INTERVAL_MS = 5_000;
export const RC_ROSTER_TICK_MS = 100;
export const RC_CONTROL_REQUEST_TIMEOUT_MS = 60_000;
export const RC_CONTROL_COOLDOWN_MS = 30_000;
export const RC_DRIVER_GRACE_MS = 30_000;
export const RC_KICK_MS = 10 * 60_000;
export const RC_ROOM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RC_ROOMS_LIST_MAX = 200;
export const RC_TITLE_MAX = 80;
export const RC_PASSWORD_MAX_FAILURES = 100;
export const RC_PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000;
export const RC_LINK_TOKEN_TTL_MS = 2 * 60 * 60_000;
export const RC_TICKET_SUBPROTOCOL_PREFIX = "atlas.rc." as const;

export function rcUtf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
```

The six **limit keys** are numbers the feature catalogue carries (§3.3): Ops can change them per Organisation and a plan can sell them. Everything else is a **constant**: it bounds the object's own resource use and no plan may buy past it.

| constant | value | meaning |
| --- | --- | --- |
| `RC_SOCKETS_MAX` | 64 | Client sockets one room serves at once; the 65th is refused `room_full` and closed `1013`. |
| `RC_SOCKETS_PER_PRINCIPAL` | 4 | Sockets one principal may hold in a room (four tabs are one person). |
| `RC_ROOM_INFLIGHT_BYTES` | 16 777 216 | Un-acked bytes across a room's client sockets before joins and snapshot waves wait. |
| `RC_VIEWER_LAG_BYTES` | 2 097 152 | A viewer this many un-acked bytes behind… |
| `RC_VIEWER_LAG_MS` | 10 000 | …for this long is cut `1013` and reconnects onto the tail path. |
| `RC_DELTA_MAX_BYTES` | 262 144 | Largest binary stream frame (any `count`) or snapshot part, header included. Never split by the object. |
| `RC_FRAME_HEADER_MAX_BYTES` | 19 | Three fixed bytes and two 8-byte varints. |
| `RC_SNAPSHOT_PART_MAX_BYTES` | 262 125 | Most snapshot payload bytes in one part, so the part stays inside `RC_DELTA_MAX_BYTES`. |
| `RC_SNAPSHOT_MAX_BYTES` | 1 048 576 | Largest reassembled snapshot. |
| `RC_REHELLO_MAX` | 3 | Re-hellos a socket may make after being un-helloed, per window. |
| `RC_REHELLO_WINDOW_MS` | 60 000 | That window. |
| `RC_HOST_PING_MS` | 15 000 | The host pings this often. |
| `RC_HOST_SILENT_MS` | 45 000 | A host silent this long is offline. |
| `RC_HOST_SWEEP_MS` | 15 000 | The host-silence sweep interval while a host is connected. |
| `RC_CLIENT_PING_MS` | 25 000 | Clients ping this often. |
| `RC_CLIENT_SILENT_MS` | 120 000 | A client silent this long is closed `1001`. |
| `RC_HELLO_TIMEOUT_MS` | 10 000 | A socket on either door with no hello this long after connecting is closed `1001`. |
| `RC_COALESCE_MS` | 33 | The desktop flushes a batch every 33 ms… |
| `RC_COALESCE_BYTES` | 8 192 | …or 8 KiB, whichever first. |
| `RC_CHECKPOINT_DEBOUNCE_MS` | 1 000 | The ring is checkpointed this long after the last host frame… |
| `RC_CHECKPOINT_MAX_MS` | 30 000 | …and at least this often while the stream never pauses. |
| `RC_COMMAND_TIMEOUT_MS` | 30 000 | A relayed command unanswered this long is `relay_timeout`. |
| `RC_COMMAND_PER_SECOND` | 2 | Steering-command refill rate per principal; the burst is the `rc_command_burst` limit. |
| `RC_COMMANDS_KEPT` | 500 | Commands remembered per room for idempotency, newest first. |
| `RC_PROMPT_MAX` | 32 768 | Largest `submit` prompt in UTF-8 bytes. |
| `RC_COMMAND_FRAME_MAX_BYTES` | 36 864 | Largest `rc.command` frame in bytes. |
| `RC_COMMAND_VALUE_MAX_BYTES` | 8 192 | Largest `answer_elicitation.answer` or `set_config_option.value`, serialised. |
| `RC_CONTROL_MAX_BYTES` | 4 096 | Largest control frame other than `rc.command` (`rc.ack` included). |
| `RC_ACK_MAX_PER_SECOND` | 10 | Acks a socket may send per second; the excess is dropped silently. |
| `RC_HOST_FIRST_HELLO_MS` | 60 000 | A host that never says hello this long after creation ends the room `never_hosted`. |
| `RC_SNAPSHOT_REQUEST_TIMEOUT_MS` | 10 000 | One snapshot request in flight; a joiner parked on it is answered after this long regardless. |
| `RC_SNAPSHOT_MIN_INTERVAL_MS` | 5 000 | An unrequested snapshot inside this window of the last is dropped. |
| `RC_ROSTER_TICK_MS` | 100 | Roster changes are coalesced on this tick; joins and snapshot waves are admitted on it too. |
| `RC_CONTROL_REQUEST_TIMEOUT_MS` | 60 000 | A control request unanswered this long times out. |
| `RC_CONTROL_COOLDOWN_MS` | 30 000 | After a decline or a timeout, a principal waits this long before asking again. |
| `RC_DRIVER_GRACE_MS` | 30 000 | The seat waits this long for a driver whose last socket closed. |
| `RC_KICK_MS` | 600 000 | A kicked principal's redial is `404` for this long; their invite stands. |
| `RC_ROOM_RETENTION_MS` | 604 800 000 | An ended room's audit is kept this long (7 days), then purged. |
| `RC_ROOMS_LIST_MAX` | 200 | Rooms one `GET /rc/rooms` lists. |
| `RC_TITLE_MAX` | 80 | Longest room title. |
| `RC_PASSWORD_MAX_FAILURES` | 100 | Per-link password failures before the link locks (unused). |
| `RC_PASSWORD_FAILURE_WINDOW_MS` | 900 000 | Their window (unused). |
| `RC_LINK_TOKEN_TTL_MS` | 7 200 000 | An RC link token's life (unused). |
| `RC_TICKET_SUBPROTOCOL_PREFIX` | `"atlas.rc."` | The subprotocol slot an RC link token will ride in (unused). |

`rcUtf8Bytes` is the byte length of a string's UTF-8 encoding, written out because the module may not assume a `TextEncoder` global; every cap above is measured with it.

### 2.3 Gates, refusals, close codes, audit events

```ts
export const RC_GATES = [
  "platform_flag",
  "org_setting",
  "org_policy",
  "room_closed",
  "owner_offline",
  "link_revoked",
  "link_expired",
  "member_removed",
  "tier",
  "not_driver",
  "epoch_stale",
  "rate_limited",
  "owner_only",
  "option_standing",
  "widening",
  "in_flight",
  "not_pending",
] as const;
export const RcGate = z.enum(RC_GATES);
export type RcGate = (typeof RC_GATES)[number];

/** The gates a start door (create, dial) can answer `403 rc_refused` with. */
export type RcDoorGate = Extract<RcGate, "platform_flag" | "org_setting">;

export const RC_REFUSAL_CODES = [
  "hello_required",
  "already_hello",
  "bad_frame",
  "payload_too_large",
  "not_host",
  "room_full",
  "seq_regressed",
  "snapshot_required",
  "snapshot_unavailable",
  "tier",
  "not_driver",
  "epoch_stale",
  "owner_offline",
  "identity_required",
  "link_expired",
  "cooldown",
  "rate_limited",
  "request_unknown",
  "request_closed",
  "not_accepting",
  "room_closed",
  "command_unknown",
  "relay_timeout",
] as const;
export const RcRefusalCode = z.enum(RC_REFUSAL_CODES);
export type RcRefusalCode = (typeof RC_REFUSAL_CODES)[number];

/** Protocol-level failures: `rc.error` is always followed by a close. */
export const RC_ERROR_CODES = ["protocol_unsupported"] as const;
export type RcErrorCode = (typeof RC_ERROR_CODES)[number];

export const RcCloseCode = {
  Idle: 1001,
  Revoked: 1008,
  TryAgainLater: 1013,
  ProtocolUnsupported: 4400,
  Forbidden: 4403,
  Superseded: 4409,
  RoomClosed: 4410,
} as const;
export type RcCloseCode = (typeof RcCloseCode)[keyof typeof RcCloseCode];

export const RC_AUDIT_EVENTS = [
  "room_created",
  "settings_changed",
  "link_created",
  "link_revoked",
  "password_set",
  "password_cleared",
  "password_locked",
  "invite_sent",
  "invite_removed",
  "member_joined",
  "host_online",
  "host_offline",
  "host_refused",
  "host_superseded",
  "resync",
  "control_requested",
  "control_granted",
  "control_declined",
  "control_timed_out",
  "control_released",
  "driver_kicked",
  "taken_over",
  "visitor_kicked",
  "command_relayed",
  "command_refused",
  "command_result",
  "command_timed_out",
  "room_closed",
  "room_ended",
  "member_revoked",
  "link_visitor_revoked",
  "scope_set",
  "scope_revoked",
] as const;
export type RcAuditEvent = (typeof RC_AUDIT_EVENTS)[number];
```

**Gates**, in the order they are asked (relay-side first, desktop-side after). A refusal from either side names one, and a client branches on the gate, never on the message.

| gate | asked by | meaning |
| --- | --- | --- |
| `platform_flag` | door | The platform's `rc.enabled` global layer is off. |
| `org_setting` | door | The scope Organisation's `rc.enabled` layer is off. |
| `org_policy` | — | The scope Organisation's link policy (reserved). |
| `room_closed` | relay | The room has ended. |
| `owner_offline` | relay | The host socket is not connected; nothing is queued. |
| `link_revoked` / `link_expired` | — | Reserved for links. |
| `member_removed` | — | Reserved; the relay cuts a removed member's socket instead of refusing a frame. |
| `tier` | relay | The sender's tier is below the command's minimum, or the kind is members-only and the sender is not a `user`. |
| `not_driver` | relay | The sender is not the driver (the owner included; `takeOver: true` rides the owner's refusal). |
| `epoch_stale` | relay | `driverEpoch` on the command is not the room's current epoch. |
| `rate_limited` | relay | The sender's command bucket is empty. |
| `owner_only` | desktop | The desktop will take that only from its own owner. |
| `option_standing` | desktop | A standing ("always allow") grant was asked for remotely. |
| `widening` | desktop | A `set_mode` to a widening mode (§2.6) from any remote origin. |
| `in_flight` | desktop | A turn is already running. |
| `not_pending` | desktop | The permission or elicitation prompt was already answered. |

**Refusal codes** (`rc.refused { code }`). A refusal is a frame, not a close: one bad frame never costs the socket. The two exceptions are marked.

| code | when the object sends it |
| --- | --- |
| `hello_required` | Any frame before a hello on this socket, or after it was un-helloed; a stream frame from a host socket that has not said hello. |
| `already_hello` | A second hello on a socket that was not told to start over. |
| `bad_frame` | Not JSON; a frame the inbound schema does not recognise; a frame kind the sending side does not send (a client hello on the host door, a host-only frame on a host that does not apply); a binary header that does not decode or fails `rcFrameProblem`. |
| `payload_too_large` | A text frame over `RC_COMMAND_FRAME_MAX_BYTES`; a non-`rc.command` control frame over `RC_CONTROL_MAX_BYTES`; a stream frame over `RC_DELTA_MAX_BYTES`; a reassembled snapshot over `RC_SNAPSHOT_MAX_BYTES`; a command failing `rcCommandSizeProblem`. |
| `not_host` | A host-only frame (`rc.resync`, `rc.command_result`, a stream frame) from a client socket; a host hello on the client door; a host hello whose `hostSecret` is missing or does not hash to the stored hash, or whose `clientId` is not the room's `owner_client_id`. |
| `room_full` | The 65th client socket's hello; **followed by close `1013`**. |
| `seq_regressed` | A stream frame whose `seqFirst` is not past the room's head. |
| `snapshot_required` | A delta while a host resync is held open and no snapshot has arrived. |
| `snapshot_unavailable` | A joiner that needed a snapshot was answered after `RC_SNAPSHOT_REQUEST_TIMEOUT_MS` (or at once with the owner offline) with what the room holds. |
| `tier`, `not_driver`, `epoch_stale`, `owner_offline`, `room_closed` | The command gates above, also carried in `rc.command_result` with `refusedBy: "relay"`. `not_driver` is also the answer to an owner-only control frame (`rc.kick`, `rc.take_over`, `rc.grant_control`, `rc.close`) from a non-owner, and to `rc.release_control` from a non-driver. |
| `identity_required`, `link_expired`, `command_unknown`, `request_closed` | Registered; never sent in this cut. |
| `cooldown` | A `rc.request_control` inside `RC_CONTROL_COOLDOWN_MS` of a decline or timeout; carries `retryAt`. |
| `rate_limited` | A re-hello past `RC_REHELLO_MAX` per `RC_REHELLO_WINDOW_MS` (**followed by close `1001`**); an operation bucket empty (control frames); a command bucket empty. |
| `request_unknown` | A `rc.control_answer` naming no open request; a `rc.grant_control` naming a principal not in the room. |
| `not_accepting` | A control request while the room's `acceptRequests` is off, from the current driver, or from the owner (who takes the seat back with `rc.take_over`). |
| `relay_timeout` | In `rc.command_result` only: the host did not answer within `RC_COMMAND_TIMEOUT_MS`; "no answer", never "refused". |

**Close codes.** Beside the thread codes, the RC sockets use:

| code | name | meaning for the client |
| --- | --- | --- |
| 1001 | `Idle` | Idle sweep, the re-hello limit, or no hello within `RC_HELLO_TIMEOUT_MS`: reconnect with backoff and say hello. |
| 1008 | `Revoked` | Access revoked (removed from the Organisation, scope revoked, kicked): **stop reconnecting**. |
| 1013 | `TryAgainLater` | `room_full` (back off at least 30 s) or a lagging viewer (reconnect with `since` on the normal backoff). |
| 4400 | `ProtocolUnsupported` | After `rc.error { code: "protocol_unsupported" }`. |
| 4403 | `Forbidden` | Not the host, or no longer a member. |
| 4409 | `Superseded` | A newer host socket presented the secret (host only). |
| 4410 | `RoomClosed` | The room closed or ended, after `rc.closed`: **stop reconnecting**. |

**Audit events** are recorded by the object only; never a stream frame, an ack or a slow-viewer cut. Those recorded in this cut: `room_created`, `settings_changed`, `host_online`, `host_offline`, `host_refused`, `host_superseded`, `resync`, `control_requested`, `control_granted`, `control_declined`, `control_timed_out`, `control_released`, `driver_kicked`, `taken_over`, `visitor_kicked`, `command_relayed`, `command_refused`, `command_result`, `command_timed_out`, `room_closed`, `room_ended`, `member_revoked`, `scope_set`, `scope_revoked`.

### 2.4 REST shapes

```ts
/** Who did something, or is somewhere, in a room. `name` is a display name, or `null`. */
export const RcPrincipalRef = z
  .object({ id: z.string().min(1), kind: z.enum(RC_PRINCIPAL_KINDS), name: z.string().nullable() })
  .strict();
export type RcPrincipalRef = z.infer<typeof RcPrincipalRef>;

export const RcScope = z
  .object({
    orgId: z.string().min(1),
    /** The project, when it is a registered (Cloud-mode) one of `orgId`. */
    workspaceId: z.string().min(1).nullable(),
  })
  .strict();
export type RcScope = z.infer<typeof RcScope>;

export const CreateRcRoomRequest = z
  .object({
    /** The multiplayer scope, or `null` for a solo room ({@link RcScope}). */
    scope: RcScope.nullable().default(null),
    /** The desktop-minted Session id. A second create for an open room on it is idempotent. */
    sessionId: z.string().min(1).max(128),
    /** The agent's own session id. Informational; never routes anything. */
    nativeSessionId: z.string().min(1).max(200).nullable().optional(),
    /** The desktop's stable replica id; only this desktop may host. */
    clientId: RcClientId,
    agent: z.string().min(1).max(100),
    model: z.string().min(1).max(200).nullable().optional(),
    /** The first 80 characters of the title; link visitors never see it. */
    title: z.string().trim().max(RC_TITLE_MAX).optional(),
    /** What invited members may do. */
    memberTier: RcTier.default("view"),
    /** What the desktop will honour. */
    capabilities: z.array(RcCapability).max(8),
  })
  .strict();
export type CreateRcRoomRequest = z.infer<typeof CreateRcRoomRequest>;

/** One room, as every door shows it. */
export interface RcRoom {
  id: string;
  /** The scope's Organisation, or `null` for a solo room ({@link RcScope}). */
  orgId: string | null;
  /** The scope's Workspace; only meaningful when `orgId` is set. */
  workspaceId: string | null;
  sessionId: string;
  agent: string;
  model: string | null;
  title: string | null;
  ownerUserId: string;
  memberTier: RcTier;
  capabilities: Array<RcCapability>;
  status: RcRoomStatus;
  driverEpoch: number | null;
  hostOnline: boolean;
  createdAt: number;
  endedAt: number | null;
  endReason: RcEndReason | null;
}

export interface CreateRcRoomResponse {
  room: RcRoom;
  hostSecret: string | null;
}

export interface RcRoomList {
  rooms: Array<RcRoom>;
  /** What the list left out, said aloud (it is bounded at {@link RC_ROOMS_LIST_MAX}). */
  notes: Array<string>;
}

/** Somebody invited into a room. */
export interface RcMember {
  userId: string;
  invitedBy: string;
  invitedAt: number;
  /** Their first socket; `null` while the invite is pending. */
  joinedAt: number | null;
}

/** `GET /rc/rooms/{roomId}` — the room owner or a member; anyone else `404`. */
export interface RcRoomResponse {
  room: RcRoom;
  members: Array<RcMember>;
}

export const UpdateRcRoomRequest = z
  .object({
    memberTier: RcTier.optional(),
    title: z.string().trim().max(RC_TITLE_MAX).nullable().optional(),
    /** `false` makes every control request decline at once. */
    acceptRequests: z.boolean().optional(),
    scope: RcScope.optional(),
  })
  .strict()
  .refine(
    (b) => b.memberTier !== undefined || b.title !== undefined || b.acceptRequests !== undefined || b.scope !== undefined,
    { message: "change at least one of memberTier, title, acceptRequests, scope" },
  );
export type UpdateRcRoomRequest = z.infer<typeof UpdateRcRoomRequest>;

export interface RcFeaturesResponse {
  /** The platform switch: a solo room needs nothing else. */
  enabled: boolean;
  /** The account's limits; `null` while the platform switch is off. */
  limits: RcLimits | null;
  /** The named Organisation's multiplayer grant. `null` without `?org=`. */
  multiplayer: { enabled: boolean; limits: RcLimits | null } | null;
  /** Whether RC links may be made. `false` until public links ship. */
  publicLinks: boolean;
  /** Whether a new RC link must carry a password. */
  passwordRequired: boolean;
  /** Whether this deployment has the Turnstile pair public links need. */
  turnstileConfigured: boolean;
}

/** `403 rc_refused`: the standard error body, plus which gate refused. */
export interface RcRefusal {
  error: { code: "rc_refused"; message: string };
  gate: RcDoorGate;
}

/** One audit row. `detail` holds scalars only — never a payload, a slug, a token or a secret. */
export interface RcAuditEntry {
  id: number;
  at: number;
  event: RcAuditEvent;
  actor: RcPrincipalRef | { id: "system"; kind: "system"; name: null };
  subject: RcPrincipalRef | null;
  requestId: string | null;
  commandId: string | null;
  driverEpoch: number | null;
  detail: Record<string, string | number | boolean | null>;
}
```

| shape | one line |
| --- | --- |
| `RcPrincipalRef` | `{ id, kind, name }`; `name` is `null` for every `user` in this cut (the server stores no display names). |
| `RcScope` | `{ orgId, workspaceId \| null }`, strict. |
| `CreateRcRoomRequest` | Strict; `scope` defaults to `null`, `memberTier` to `"view"`; `title` is trimmed; `capabilities` at most 8. |
| `RcRoom` | `driverEpoch` is `null` in a list (listing never wakes a room); `hostOnline` is the object's answer on the room's own door, else the directory row's mirror, and `false` once ended. |
| `CreateRcRoomResponse` | `hostSecret` is 64 hex in the `201` and `null` in the idempotent `200`, **nowhere else, ever**. |
| `RcRoomList` | Open first, newest first, at most 200; `notes` says what was left out. |
| `RcMember` | One `rc_members` row. |
| `RcRoomResponse` | The room from the object plus its member rows. |
| `UpdateRcRoomRequest` | Strict; at least one field; `title: ""` or `null` clears the title. |
| `RcFeaturesResponse` | A drawing hint, never the enforcement. |
| `RcRefusal` | The error envelope plus `gate`. |
| `RcAuditEntry` | Declared for the later audit door. |

**Error body.** Every REST refusal from ingest, and from the object, is `{ error: { code, message } }` where `code` is one of `ARTIFACT_ERROR_CODES` in `packages/contracts/src/workspaces.ts`. The RC additions to that list, verbatim:

```ts
  // Additive, Universal RC: the `/rc` doors, desktop- and web-side; the drain
  // never calls them.
  "rc_refused", // 403 — an RC gate said no; the body names it in `gate`
  "rc_closed", // 409 — the room has ended
  "rc_not_owner", // 403 — only the room owner may do this
  "rc_no_scope", // 409 — the room has no scope (it is solo), and this needs one: invite, org policy
  "rc_scope_set", // 409 — the room's scope is set already; it is set once
```

The codes the RC doors also use from the existing list: `bad_request` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `limit_reached` (409), `rate_limited` (429), `unavailable` (503).

### 2.5 Wire protocol v1 — binary stream frames

```ts
export const RcFrameKind = {
  DeltaBatch: 1,
  Snapshot: 2,
} as const;
export type RcFrameKind = (typeof RcFrameKind)[keyof typeof RcFrameKind];

/** `flags` bit 0: a snapshot continues in the next frame. Other bits are reserved and sent as 0. */
export const RC_FRAME_FLAG_MORE = 0x01;

export interface RcFrame {
  version: number;
  kind: number;
  flags: number;
  seqFirst: number;
  count: number;
  payload: Uint8Array;
}

export function encodeRcFrame(frame: Omit<RcFrame, "version"> & { version?: number }): Uint8Array {
  if (!Number.isInteger(frame.flags) || frame.flags < 0 || frame.flags > 0xff) {
    throw new RangeError(`flags out of range: ${frame.flags}`);
  }
  const header: Array<number> = [frame.version ?? RC_PROTOCOL_VERSION, frame.kind, frame.flags];
  writeVarint(header, frame.seqFirst);
  writeVarint(header, frame.count);
  const out = new Uint8Array(header.length + frame.payload.length);
  out.set(header, 0);
  out.set(frame.payload, header.length);
  return out;
}

export function decodeRcFrame(bytes: Uint8Array): RcFrame | null {
  if (bytes.length < 3) return null;
  const at = { i: 3 };
  const seqFirst = readVarint(bytes, at);
  const count = seqFirst === null ? null : readVarint(bytes, at);
  if (seqFirst === null || count === null) return null;
  return {
    version: bytes[0]!,
    kind: bytes[1]!,
    flags: bytes[2]!,
    seqFirst,
    count,
    payload: bytes.subarray(at.i),
  };
}

export function rcFrameProblem(frame: RcFrame): string | null {
  if (frame.version !== RC_PROTOCOL_VERSION) return `frame version ${frame.version} is not ${RC_PROTOCOL_VERSION}`;
  if (frame.kind !== RcFrameKind.DeltaBatch && frame.kind !== RcFrameKind.Snapshot) {
    return `frame kind ${frame.kind} is not a delta batch (1) or a snapshot (2)`;
  }
  if (frame.count < 1) return "count is at least 1";
  if (frame.kind === RcFrameKind.Snapshot && frame.count !== 1) return "a snapshot part has count 1";
  if (frame.seqFirst + frame.count - 1 > Number.MAX_SAFE_INTEGER) return "seq out of range";
  return null;
}

/** The last seq a frame covers. */
export function rcFrameSeqLast(frame: Pick<RcFrame, "seqFirst" | "count">): number {
  return frame.seqFirst + frame.count - 1;
}

/** A kind-1 batch frame from envelopes already serialised to bytes, in seq order. */
export function encodeRcDeltaBatch(seqFirst: number, envelopes: ReadonlyArray<Uint8Array>): Uint8Array {
  if (envelopes.length < 1) throw new RangeError("a batch carries at least one envelope");
  const lengths: Array<Array<number>> = envelopes.map((e) => {
    const out: Array<number> = [];
    writeVarint(out, e.length);
    return out;
  });
  const size = envelopes.reduce((n, e, i) => n + lengths[i]!.length + e.length, 0);
  const payload = new Uint8Array(size);
  let at = 0;
  envelopes.forEach((e, i) => {
    payload.set(lengths[i]!, at);
    at += lengths[i]!.length;
    payload.set(e, at);
    at += e.length;
  });
  return encodeRcFrame({ kind: RcFrameKind.DeltaBatch, flags: 0, seqFirst, count: envelopes.length, payload });
}

export function decodeRcDeltaBatch(frame: RcFrame): Array<Uint8Array> | null {
  if (frame.kind !== RcFrameKind.DeltaBatch) return null;
  const out: Array<Uint8Array> = [];
  const at = { i: 0 };
  for (let n = 0; n < frame.count; n++) {
    const len = readVarint(frame.payload, at);
    if (len === null || at.i + len > frame.payload.length) return null;
    out.push(frame.payload.subarray(at.i, at.i + len));
    at.i += len;
  }
  return at.i === frame.payload.length ? out : null;
}
```

**Format.** A binary WebSocket message is `version u8 | kind u8 | flags u8 | seq_first varint | count varint | payload…`. Varints are unsigned LEB128, at most 8 bytes, and never exceed 2^53 − 1. `version` is always `1`. `kind 1` is a **delta batch**: `count` consecutive deltas `seqFirst … seqFirst + count − 1`, and the payload is `count` × (`len` varint | `len` bytes of redacted `SessionDeltaEnvelope` JSON), in seq order; `count = 1` is the un-batched frame. `kind 2` is one **snapshot part** as of `seqFirst`; `count` is `1`; `flags & 0x01` (`MORE`) says another part follows. The object reads the header only; the payload is relayed and replayed byte for byte.

**Behaviour on bad input.** `encodeRcFrame` throws `RangeError` when `flags` is not an integer in `0…255`, or when `seqFirst` or `count` is negative or not a safe integer (from `writeVarint`). `decodeRcFrame` returns `null` when the input is under 3 bytes, when either varint runs out of bytes, runs past 8 bytes, or exceeds `Number.MAX_SAFE_INTEGER`; its `payload` is a view onto the input, not a copy. `rcFrameProblem` returns the reason a decoded frame is not one the protocol carries (`version ≠ 1`, kind not 1 or 2, `count < 1`, a snapshot part with `count ≠ 1`, last seq past the safe range) or `null`; the object answers any of these `bad_frame`. `decodeRcDeltaBatch` returns `null` unless the `count` length prefixes account for the payload exactly; a client calls it before `JSON.parse`, the object never does.

### 2.6 Wire protocol v1 — JSON control frames, client → server

```ts
const Seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Epoch = z.number().int().min(1);

export const RcHostHello = z
  .object({
    t: z.literal("rc.hello"),
    protocol: z.number().int(),
    role: z.literal("host"),
    clientId: RcClientId,
    hostSecret: z.string().max(128).optional(),
    /** The desktop's current session seq; `0` before its first delta. */
    as_of_seq: Seq,
    capabilities: z.array(RcCapability).max(8),
    agent: z.string().min(1).max(100),
    model: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type RcHostHello = z.infer<typeof RcHostHello>;

/** A client's first frame. `since` is the newest seq it has applied; `0` on a fresh page. */
export const RcClientHello = z
  .object({
    t: z.literal("rc.hello"),
    protocol: z.number().int(),
    role: z.literal("client"),
    clientId: RcClientId,
    since: Seq,
    surface: z.enum(RC_SURFACES),
  })
  .strict();
export type RcClientHello = z.infer<typeof RcClientHello>;

export const RcHello = z.discriminatedUnion("role", [RcHostHello, RcClientHello]);
export type RcHello = z.infer<typeof RcHello>;

export const RcAck = z.object({ t: z.literal("rc.ack"), seq: Seq }).strict();

export const RcHostResync = z.object({ t: z.literal("rc.resync"), as_of_seq: Seq }).strict();

export const RcCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("submit"),
      content: z.string().min(1),
      clientMessageId: z.string().max(64).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("stop") }).strict(),
  z
    .object({ kind: z.literal("answer_permission"), requestId: z.string().min(1).max(128), optionId: z.string().min(1).max(128) })
    .strict(),
  z
    .object({ kind: z.literal("answer_elicitation"), requestId: z.string().min(1).max(128), answer: z.unknown() })
    .strict(),
  z.object({ kind: z.literal("set_mode"), modeId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("set_model"), modelId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("set_config_option"), key: z.string().min(1).max(100), value: z.unknown() }).strict(),
]);
export type RcCommand = z.infer<typeof RcCommand>;
export const RC_COMMAND_KINDS = [
  "submit",
  "stop",
  "answer_permission",
  "answer_elicitation",
  "set_mode",
  "set_model",
  "set_config_option",
] as const;
export type RcCommandKind = (typeof RC_COMMAND_KINDS)[number];

/** The least tier each command kind needs, before the driver and epoch checks. */
export const RC_COMMAND_MIN_TIER: Record<RcCommandKind, RcTier> = {
  submit: "steer",
  stop: "steer",
  answer_permission: "steer_approve",
  answer_elicitation: "steer_approve",
  set_mode: "steer",
  set_model: "steer",
  set_config_option: "steer",
};

export const RC_MEMBERS_ONLY_COMMANDS: ReadonlyArray<RcCommandKind> = ["set_config_option"];

export const RC_WIDENING_MODE_WORDS = [
  "bypass",
  "full",
  "yolo",
  "danger",
  "unrestricted",
  "auto",
  "trust",
  "skip",
  "unsafe",
  "always",
] as const;

/** Is `modeId` a mode only the desktop may choose ({@link RC_WIDENING_MODE_WORDS})? */
export function rcModeIsWidening(modeId: string): boolean {
  const id = modeId.toLowerCase();
  return RC_WIDENING_MODE_WORDS.some((word) => id.includes(word));
}

/** Does `tier` reach the tier `kind` needs? */
export function rcTierAllows(tier: RcTier, kind: RcCommandKind): boolean {
  return RC_TIERS.indexOf(tier) >= RC_TIERS.indexOf(RC_COMMAND_MIN_TIER[kind]);
}

export function rcCommandSizeProblem(command: RcCommand): string | null {
  if (command.kind === "submit" && rcUtf8Bytes(command.content) > RC_PROMPT_MAX) {
    return `a prompt is at most ${RC_PROMPT_MAX} bytes`;
  }
  const value =
    command.kind === "answer_elicitation" ? command.answer : command.kind === "set_config_option" ? command.value : undefined;
  if (value !== undefined && rcUtf8Bytes(JSON.stringify(value) ?? "") > RC_COMMAND_VALUE_MAX_BYTES) {
    return `a value is at most ${RC_COMMAND_VALUE_MAX_BYTES} bytes serialised`;
  }
  return null;
}

export const RcCommandFrame = z
  .object({ t: z.literal("rc.command"), commandId: RcCommandId, driverEpoch: Epoch, command: RcCommand })
  .strict();
export type RcCommandFrame = z.infer<typeof RcCommandFrame>;

export const RcHostCommandResult = z.union([
  z
    .object({
      t: z.literal("rc.command_result"),
      commandId: RcCommandId,
      fromId: z.string().min(1).max(200),
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      t: z.literal("rc.command_result"),
      commandId: RcCommandId,
      fromId: z.string().min(1).max(200),
      ok: z.literal(false),
      refusedBy: z.literal("desktop"),
      gate: RcGate,
      code: z.string().min(1).max(64),
      message: z.string().max(500),
    })
    .strict(),
]);
export type RcHostCommandResult = z.infer<typeof RcHostCommandResult>;

/** Ask for the driver seat (tier `steer` or above, with a name). */
export const RcRequestControl = z.object({ t: z.literal("rc.request_control") }).strict();
/** The driver or the room owner answers a control request. */
export const RcControlAnswer = z
  .object({ t: z.literal("rc.control_answer"), requestId: z.string().min(1).max(64), approve: z.boolean() })
  .strict();
/** The driver hands the seat back to the room owner. */
export const RcReleaseControl = z.object({ t: z.literal("rc.release_control") }).strict();
/** Room owner: cut a visitor's sockets (a driver kicked loses the seat to the owner). `target` is a principal id. */
export const RcKick = z.object({ t: z.literal("rc.kick"), target: z.string().min(1).max(200) }).strict();
/** Room owner: take the driver seat back. */
export const RcTakeOver = z.object({ t: z.literal("rc.take_over") }).strict();
/** Room owner: hand the seat to a connected visitor. `target` is a principal id in the room now with tier `steer` or above. */
export const RcGrantControl = z.object({ t: z.literal("rc.grant_control"), target: z.string().min(1).max(200) }).strict();
/** Room owner: end the room. */
export const RcCloseFrame = z.object({ t: z.literal("rc.close") }).strict();

const RcInboundOther = z.discriminatedUnion("t", [
  RcAck,
  RcHostResync,
  RcCommandFrame,
  RcRequestControl,
  RcControlAnswer,
  RcReleaseControl,
  RcKick,
  RcTakeOver,
  RcGrantControl,
  RcCloseFrame,
]);

export const RcInboundControl = z.union([RcHello, RcHostCommandResult, RcInboundOther]);
export type RcInboundControl = z.infer<typeof RcInboundControl>;
```

| frame | sent by | meaning |
| --- | --- | --- |
| `rc.hello` (host) | host | First frame. `hostSecret` is optional in the schema only so a hello without one is refused `not_host` like a wrong one; every host sends it. `protocol` must be `1`, else `rc.error protocol_unsupported` and close `4400`. |
| `rc.hello` (client) | client | First frame; `since` is the newest seq applied, `0` on a fresh page. |
| `rc.ack` | client | Newest seq applied; every 1 s while frames arrive or every 64 KiB, whichever first. The host never acks. |
| `rc.resync` | host | The host's outbound queue overflowed or it redialled ahead of the room: discard everything at or below `as_of_seq`; a snapshot follows and no delta is taken until it has. |
| `rc.command` | client | One steering command under the epoch the client last saw; no `from`, the object stamps the sender. |
| `rc.command_result` | host | The answer to one relayed command within 30 s; `fromId` echoes the relayed `from.id` because commands are keyed `(from, commandId)`. |
| `rc.request_control` | client | Ask for the seat. |
| `rc.control_answer` | host, owner's clients, driver | Approve or decline one request. |
| `rc.release_control` | driver | Hand the seat back to the owner. |
| `rc.kick` | host, owner's clients | Cut a principal's sockets; a kicked driver loses the seat. |
| `rc.take_over` | host, owner's clients | Take the seat back; the epoch advances. |
| `rc.grant_control` | host, owner's clients | Hand the seat to a connected principal with tier ≥ `steer`; the epoch advances; only the new driver may steer until take-over or release. |
| `rc.close` | host, owner's clients | End the room. |

`RC_WIDENING_MODE_WORDS` are, in order, `bypass`, `full`, `yolo`, `danger`, `unrestricted`, `auto`, `trust`, `skip`, `unsafe`, `always`; `rcModeIsWidening` lower-cases the mode id and returns `true` when any word is a substring. A remote `set_mode` to such a mode is refused `widening` by the desktop for every remote origin, the owner included; the web pre-disables those rows. `RC_COMMAND_MIN_TIER` and `RC_MEMBERS_ONLY_COMMANDS` are repeated as tables:

| kind | minimum tier | members only |
| --- | --- | --- |
| `submit` | `steer` | no |
| `stop` | `steer` | no |
| `answer_permission` | `steer_approve` | no |
| `answer_elicitation` | `steer_approve` | no |
| `set_mode` | `steer` | no |
| `set_model` | `steer` | no |
| `set_config_option` | `steer` | **yes** |

### 2.7 Wire protocol v1 — JSON control frames, server → client

```ts
/** A control request (§9.2). */
export const RcControlRequestSchema = z
  .object({
    requestId: z.string().min(1),
    from: RcPrincipalRef,
    status: z.enum(["pending", "approved", "declined", "timed_out"]),
    requestedAt: z.number(),
    expiresAt: z.number(),
    answeredAt: z.number().nullable(),
    /** Why it was declined: `not_accepting`, `access_revoked`, `room_closed`, … */
    reason: z.string().nullable(),
  })
  .strict();
export type RcControlRequest = z.infer<typeof RcControlRequestSchema>;

/** The answer to a host's hello. `wants: "snapshot"` asks for `rc.resync` then a snapshot. */
export const RcHostWelcome = z
  .object({
    t: z.literal("rc.welcome"),
    protocol: z.literal(RC_PROTOCOL_VERSION),
    roomId: z.string().min(1),
    orgId: z.string().min(1).nullable(),
    workspaceId: z.string().min(1).nullable(),
    role: z.literal("host"),
    /** The newest seq the room holds; `0` when none. */
    head: Seq,
    driverEpoch: Epoch,
    driver: RcPrincipalRef,
    /** The stored snapshot's `as_of_seq`, or `null` when there is none. */
    snapshotAsOf: Seq.nullable(),
    wants: z.enum(["snapshot", "nothing"]),
  })
  .strict();

export const RcClientWelcome = z
  .object({
    t: z.literal("rc.welcome"),
    protocol: z.literal(RC_PROTOCOL_VERSION),
    roomId: z.string().min(1).optional(),
    role: z.enum(RC_CLIENT_ROLES),
    principal: RcPrincipalRef,
    tier: RcTier,
    driverEpoch: Epoch,
    driver: RcPrincipalRef,
    ownerOnline: z.boolean(),
    head: Seq,
    /** The oldest seq the tail still holds. A `since` below `tailFloor − 1` is served a snapshot first. */
    tailFloor: Seq,
    /** Control requests still open that concern this socket. */
    pending: z.array(RcControlRequestSchema),
  })
  .strict();

export const RcWelcome = z.discriminatedUnion("role", [RcHostWelcome, RcClientWelcome]);
export type RcWelcome = z.infer<typeof RcWelcome>;

/** The catch-up is done: everything up to `head` has been sent. Live frames follow. */
export const RcSynced = z.object({ t: z.literal("rc.synced"), head: Seq }).strict();

/** The driver, as the roster names it. `lost` while the seat waits out a driver's reconnect. */
const RcDriverRef = z
  .object({
    id: z.string().min(1),
    kind: z.enum(RC_PRINCIPAL_KINDS),
    name: z.string().nullable(),
    lost: z.boolean().optional(),
  })
  .strict();

/** One connected client socket, as members see it. The host socket is never a peer. */
export const RcPeer = z
  .object({
    /** The socket's `clientId`. */
    peerId: z.string(),
    id: z.string(),
    kind: z.enum(RC_PRINCIPAL_KINDS),
    name: z.string().nullable(),
    surface: z.enum(RC_SURFACES),
    role: z.enum(RC_ROSTER_ROLES),
    tier: RcTier,
    /** When the socket connected. */
    since: z.number(),
  })
  .strict();
export type RcPeer = z.infer<typeof RcPeer>;

/** The whole roster, never a delta. Members, the room owner and the host get it. */
export const RcRosterFull = z
  .object({
    t: z.literal("rc.roster"),
    scope: z.literal("full"),
    driverEpoch: Epoch,
    ownerOnline: z.boolean(),
    driver: RcDriverRef,
    peers: z.array(RcPeer),
  })
  .strict();

/** What a link visitor is told: counts, and the driver's display name. */
export const RcRosterGuest = z
  .object({
    t: z.literal("rc.roster"),
    scope: z.literal("guest"),
    driverEpoch: Epoch,
    ownerOnline: z.boolean(),
    driver: z
      .object({ kind: z.enum(RC_PRINCIPAL_KINDS), name: z.string().nullable(), lost: z.boolean().optional() })
      .strict(),
    you: z.enum(["visitor", "driver"]),
    counts: z.object({ members: z.number().int().min(0), visitors: z.number().int().min(0) }).strict(),
  })
  .strict();

export const RcRoster = z.discriminatedUnion("scope", [RcRosterFull, RcRosterGuest]);
export type RcRoster = z.infer<typeof RcRoster>;

/** The owner's desktop left (`graceEndsAt`: the room ends then unless it returns) or came back. */
export const RcOwnerFrame = z
  .object({ t: z.literal("rc.owner"), online: z.boolean(), graceEndsAt: z.number().optional() })
  .strict();

/** A control request changed, or arrived for the driver, the room owner or the host to answer. */
export const RcControlRequestFrame = z
  .object({ t: z.literal("rc.control_request"), request: RcControlRequestSchema })
  .strict();

/** To the host: a command that passed every relay gate. `from` is the object's, never the sender's. */
export const RcHostCommand = z
  .object({
    t: z.literal("rc.command"),
    commandId: RcCommandId,
    driverEpoch: Epoch,
    from: RcPrincipalRef,
    command: RcCommand,
  })
  .strict();
export type RcHostCommand = z.infer<typeof RcHostCommand>;

export const RcCommandResultFrame = z
  .object({
    t: z.literal("rc.command_result"),
    commandId: RcCommandId,
    ok: z.boolean().nullable(),
    status: z.literal("pending").optional(),
    refusedBy: z.enum(["relay", "desktop"]).optional(),
    gate: RcGate.optional(),
    code: z.string().min(1).max(64).optional(),
    message: z.string().optional(),
    takeOver: z.literal(true).optional(),
  })
  .strict();
export type RcCommandResultFrame = z.infer<typeof RcCommandResultFrame>;

/** To the host: send a snapshot (after `rc.resync` if the room asked for one on welcome). */
export const RcSnapshotRequest = z
  .object({ t: z.literal("rc.snapshot_request"), reason: z.enum(["joiner", "gap", "stale", "checkpoint"]) })
  .strict();

export const RcClientResync = z
  .object({ t: z.literal("rc.resync"), as_of_seq: Seq, reason: z.enum(["host", "ahead", "lagging"]) })
  .strict();

/** The room ended; the socket closes `4410` next. */
export const RcClosed = z.object({ t: z.literal("rc.closed"), reason: RcEndReason }).strict();

/** One frame refused. `ref` is the refused frame's `commandId` or `requestId` when it had one. */
export const RcRefused = z
  .object({
    t: z.literal("rc.refused"),
    ref: z.string().optional(),
    code: RcRefusalCode,
    message: z.string(),
    /** When a `cooldown` ends. */
    retryAt: z.number().optional(),
  })
  .strict();
export type RcRefused = z.infer<typeof RcRefused>;

/** Protocol-level failure; the socket closes next. */
export const RcErrorFrame = z
  .object({ t: z.literal("rc.error"), code: z.enum(RC_ERROR_CODES), message: z.string() })
  .strict();

const RcServerOther = z.discriminatedUnion("t", [
  RcSynced,
  RcOwnerFrame,
  RcControlRequestFrame,
  RcHostCommand,
  RcCommandResultFrame,
  RcSnapshotRequest,
  RcClientResync,
  RcClosed,
  RcRefused,
  RcErrorFrame,
]);

/** Every control frame the object sends, to a host or a client, for validation on receipt. */
export const RcServerControl = z.union([RcWelcome, RcRoster, RcServerOther]);
export type RcServerControl = z.infer<typeof RcServerControl>;
```

| frame | to | meaning |
| --- | --- | --- |
| `rc.welcome` (host) | host | The answer to a host hello: the room id, its scope (both `null` for a solo room), the head, the seat, the stored snapshot's seq, and whether the room wants a snapshot. |
| `rc.welcome` (client) | client | The answer to a client hello: who the socket is, its role and tier, the seat, whether the host is connected, the head and the tail floor, and open control requests that concern it. `roomId` is present for members and absent for a link visitor. |
| `rc.synced` | client | The catch-up is complete up to `head`; live frames follow. |
| `rc.roster` (full) | host, owner, members | The whole roster, never a delta; `driver.lost` while the seat waits out a driver's reconnect. |
| `rc.roster` (guest) | link visitors | Counts and the driver's name only (unused in this cut). |
| `rc.owner` | clients | The host went offline (`graceEndsAt` = when the room ends unless it returns) or came back. |
| `rc.control_request` | host, owner's clients, driver, the asker | A control request was created or changed. |
| `rc.command` | host | A command that passed every relay gate, stamped with the object's `from`. |
| `rc.command_result` | the sender | The same frame whichever side refused. `ok: null, status: "pending"` answers a resend of a command still in flight. `relay_timeout` carries no `gate`. `takeOver: true` rides a `not_driver` refusal to the room owner. |
| `rc.snapshot_request` | host | Send a snapshot; `reason` is `joiner`, `gap`, `stale` or `checkpoint`. |
| `rc.resync` | client | `host`: discard at or below `as_of_seq`, a snapshot follows; `ahead`: you were un-helloed, hello again with `since: 0`; `lagging`: the socket closes `1013`, reconnect with `since`. |
| `rc.closed` | all | The room ended; close `4410` follows. |
| `rc.refused` | the sender | One frame refused (§2.3). |
| `rc.error` | the sender | Protocol-level failure; close follows. |

### 2.8 Fixtures

Two exports, mirrored as two JSON files in `packages/contracts/fixtures/`.

```ts
export const RC_WIRE_FIXTURES: ReadonlyArray<{
  name: string;
  frame: Omit<RcFrame, "payload"> & { payload: Array<number> };
  envelopes?: Array<string>;
  hex: string;
}> = rcWireFixtures();

function asciiBytes(text: string): Array<number> {
  return [...text].map((c) => {
    const code = c.charCodeAt(0);
    if (code > 0x7f) throw new RangeError("fixtures are ASCII");
    return code;
  });
}

function toHex(bytes: ReadonlyArray<number>): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function rcWireFixtures() {
  const e = (seq: number, body: string) =>
    `{"agent_id":"atlas-agent","session_id":"ses_01","seq":${seq},${body}}`;
  const one = [e(1, `"kind":"text_chunk","message_id":"m1","delta":"Hel"`)];
  const three = [
    e(2, `"kind":"text_chunk","message_id":"m1","delta":"lo, "`),
    e(3, `"kind":"text_chunk","message_id":"m1","delta":"world"`),
    e(
      4,
      `"kind":"tool_call_upserted","message_id":"m1","tool_call":{"id":"tc_1","name":"read_file","status":"pending","args":{"path":"src/main.rs"}}`,
    ),
  ];
  const far = [e(300, `"kind":"status","status":"idle","turn_seq":2`)];
  const huge = [e(2 ** 32, `"kind":"text_chunk","message_id":"m9","delta":"."`)];
  const snapshot = `{"as_of_seq":4,"messages":[{"id":"m1","role":"assistant","content":"Hello, world"}],"pending_permissions":[]}`;
  const half = Math.floor(snapshot.length / 2);
  const batch = (envelopes: Array<string>): Array<number> =>
    envelopes.flatMap((text) => {
      const bytes = asciiBytes(text);
      const len: Array<number> = [];
      writeVarint(len, bytes.length);
      return [...len, ...bytes];
    });
  const fixture = (
    name: string,
    kind: number,
    flags: number,
    seqFirst: number,
    count: number,
    header: string,
    payload: Array<number>,
    envelopes?: Array<string>,
  ) => ({
    name,
    frame: { version: 1, kind, flags, seqFirst, count, payload },
    ...(envelopes === undefined ? {} : { envelopes }),
    hex: header + toHex(payload),
  });
  return [
    fixture("delta, count 1", 1, 0, 1, 1, "010100" + "01" + "01", batch(one), one),
    fixture("delta batch, count 3, one envelope over 127 bytes", 1, 0, 2, 3, "010100" + "02" + "03", batch(three), three),
    fixture("delta, multi-byte seq", 1, 0, 300, 1, "010100" + "ac02" + "01", batch(far), far),
    fixture("delta, seq past 2^32", 1, 0, 2 ** 32, 1, "010100" + "8080808010" + "01", batch(huge), huge),
    fixture("snapshot as of 4, part 1 of 2 (more)", 2, 1, 4, 1, "010201" + "04" + "01", asciiBytes(snapshot.slice(0, half))),
    fixture("snapshot as of 4, part 2 of 2", 2, 0, 4, 1, "010200" + "04" + "01", asciiBytes(snapshot.slice(half))),
  ];
}
```

The header hex of each wire fixture is written by hand so the fixture checks the encoder rather than restating it.

```ts
const FIXTURE_ULID = "01JB8Z5G7Q2W3E4R5T6Y7V8X9Z";
const OWNER: RcPrincipalRef = { id: "user_owner", kind: "user", name: null };
const MEMBER: RcPrincipalRef = { id: "user_member", kind: "user", name: null };
const GUEST: RcPrincipalRef = { id: "guest:3f2a9c0d4b1e8f7a6c5d4e3f2a1b0c9d", kind: "guest", name: "Ada" };

export const RC_FRAME_FIXTURES = {
  protocol: RC_PROTOCOL_VERSION,
  enums: {
    tiers: [...RC_TIERS],
    linkTiers: [...RC_LINK_TIERS],
    capabilities: [...RC_CAPABILITIES],
    surfaces: [...RC_SURFACES],
    principalKinds: [...RC_PRINCIPAL_KINDS],
    clientRoles: [...RC_CLIENT_ROLES],
    rosterRoles: [...RC_ROSTER_ROLES],
    endReasons: [...RC_END_REASONS],
    gates: [...RC_GATES],
    refusals: [...RC_REFUSAL_CODES],
    errors: [...RC_ERROR_CODES],
    commandKinds: [...RC_COMMAND_KINDS],
    auditEvents: [...RC_AUDIT_EVENTS],
  },
  commandMinTier: { ...RC_COMMAND_MIN_TIER },
  membersOnlyCommands: [...RC_MEMBERS_ONLY_COMMANDS],
  closeCodes: { ...RcCloseCode },
  frameKinds: { ...RcFrameKind },
  flagMore: RC_FRAME_FLAG_MORE,
  constants: {
    RC_SOCKETS_MAX,
    RC_SOCKETS_PER_PRINCIPAL,
    RC_DELTA_MAX_BYTES,
    RC_FRAME_HEADER_MAX_BYTES,
    RC_SNAPSHOT_PART_MAX_BYTES,
    RC_SNAPSHOT_MAX_BYTES,
    RC_HOST_PING_MS,
    RC_HOST_SILENT_MS,
    RC_CLIENT_PING_MS,
    RC_COALESCE_MS,
    RC_COALESCE_BYTES,
    RC_COMMAND_TIMEOUT_MS,
    RC_PROMPT_MAX,
    RC_COMMAND_FRAME_MAX_BYTES,
    RC_COMMAND_VALUE_MAX_BYTES,
    RC_CONTROL_MAX_BYTES,
    RC_REHELLO_MAX,
    RC_HELLO_TIMEOUT_MS,
    RC_KICK_MS,
    RC_CONTROL_REQUEST_TIMEOUT_MS,
    RC_CONTROL_COOLDOWN_MS,
    RC_VIEWER_LAG_BYTES,
    RC_VIEWER_LAG_MS,
    RC_WIDENING_MODE_WORDS: [...RC_WIDENING_MODE_WORDS],
  },
  toServer: [
    {
      name: "host hello",
      from: "host",
      frame: {
        t: "rc.hello",
        protocol: 1,
        role: "host",
        clientId: "desk-7f3a9c21",
        hostSecret: "9b".repeat(32),
        as_of_seq: 42,
        capabilities: ["steer", "approve", "mode", "model", "config"],
        agent: "atlas-agent",
        model: "claude-opus-5",
      },
    },
    {
      name: "client hello",
      from: "client",
      frame: { t: "rc.hello", protocol: 1, role: "client", clientId: "web-tab-0001", since: 0, surface: "web" },
    },
    { name: "ack", from: "client", frame: { t: "rc.ack", seq: 42 } },
    { name: "host resync", from: "host", frame: { t: "rc.resync", as_of_seq: 57 } },
    {
      name: "command: submit",
      from: "client",
      frame: {
        t: "rc.command",
        commandId: FIXTURE_ULID,
        driverEpoch: 1,
        command: { kind: "submit", content: "Run the tests again", clientMessageId: "msg-0001" },
      },
    },
    { name: "command: stop", from: "client", frame: { t: "rc.command", commandId: FIXTURE_ULID, driverEpoch: 1, command: { kind: "stop" } } },
    {
      name: "command: answer_permission",
      from: "client",
      frame: {
        t: "rc.command",
        commandId: FIXTURE_ULID,
        driverEpoch: 2,
        command: { kind: "answer_permission", requestId: "perm-1", optionId: "allow_once" },
      },
    },
    {
      name: "command: answer_elicitation",
      from: "client",
      frame: {
        t: "rc.command",
        commandId: FIXTURE_ULID,
        driverEpoch: 2,
        command: { kind: "answer_elicitation", requestId: "elic-1", answer: { branch: "main" } },
      },
    },
    {
      name: "command: set_mode",
      from: "client",
      frame: { t: "rc.command", commandId: FIXTURE_ULID, driverEpoch: 1, command: { kind: "set_mode", modeId: "plan" } },
    },
    {
      name: "command: set_model",
      from: "client",
      frame: { t: "rc.command", commandId: FIXTURE_ULID, driverEpoch: 1, command: { kind: "set_model", modelId: "claude-sonnet-5" } },
    },
    {
      name: "command: set_config_option",
      from: "client",
      frame: {
        t: "rc.command",
        commandId: FIXTURE_ULID,
        driverEpoch: 1,
        command: { kind: "set_config_option", key: "thinking_budget", value: 8000 },
      },
    },
    {
      name: "command result: accepted",
      from: "host",
      frame: { t: "rc.command_result", commandId: FIXTURE_ULID, fromId: "user_owner", ok: true },
    },
    {
      name: "command result: refused by the desktop",
      from: "host",
      frame: {
        t: "rc.command_result",
        commandId: FIXTURE_ULID,
        fromId: "user_member",
        ok: false,
        refusedBy: "desktop",
        gate: "in_flight",
        code: "in_flight",
        message: "a turn is already running",
      },
    },
    { name: "request control", from: "client", frame: { t: "rc.request_control" } },
    {
      name: "control answer",
      from: "host",
      frame: { t: "rc.control_answer", requestId: FIXTURE_ULID, approve: true },
    },
    { name: "release control", from: "client", frame: { t: "rc.release_control" } },
    { name: "kick", from: "host", frame: { t: "rc.kick", target: GUEST.id } },
    { name: "take over", from: "host", frame: { t: "rc.take_over" } },
    { name: "grant control", from: "host", frame: { t: "rc.grant_control", target: MEMBER.id } },
    { name: "close", from: "host", frame: { t: "rc.close" } },
  ],
  fromServer: [
    {
      name: "host welcome",
      to: "host",
      frame: {
        t: "rc.welcome",
        protocol: 1,
        roomId: FIXTURE_ULID,
        orgId: "org_01",
        workspaceId: "01JB8Z5G7Q2W3E4R5T6Y7V8WS1",
        role: "host",
        head: 40,
        driverEpoch: 1,
        driver: OWNER,
        snapshotAsOf: 12,
        wants: "snapshot",
      },
    },
    {
      name: "host welcome (solo room)",
      to: "host",
      frame: {
        t: "rc.welcome",
        protocol: 1,
        roomId: FIXTURE_ULID,
        orgId: null,
        workspaceId: null,
        role: "host",
        head: 0,
        driverEpoch: 1,
        driver: OWNER,
        snapshotAsOf: null,
        wants: "nothing",
      },
    },
    {
      name: "client welcome (member)",
      to: "client",
      frame: {
        t: "rc.welcome",
        protocol: 1,
        roomId: FIXTURE_ULID,
        role: "member",
        principal: MEMBER,
        tier: "steer",
        driverEpoch: 1,
        driver: OWNER,
        ownerOnline: true,
        head: 40,
        tailFloor: 13,
        pending: [],
      },
    },
    {
      name: "client welcome (link visitor)",
      to: "client",
      frame: {
        t: "rc.welcome",
        protocol: 1,
        role: "link",
        principal: GUEST,
        tier: "view",
        driverEpoch: 1,
        driver: OWNER,
        ownerOnline: false,
        head: 40,
        tailFloor: 13,
        pending: [],
      },
    },
    { name: "synced", to: "client", frame: { t: "rc.synced", head: 40 } },
    {
      name: "roster (full)",
      to: "client",
      frame: {
        t: "rc.roster",
        scope: "full",
        driverEpoch: 1,
        ownerOnline: true,
        driver: { ...OWNER },
        peers: [
          { peerId: "phone-0001", id: OWNER.id, kind: "user", name: null, surface: "mobile", role: "owner", tier: "steer_approve", since: 1761200000000 },
          { peerId: "web-tab-0001", id: MEMBER.id, kind: "user", name: null, surface: "web", role: "visitor", tier: "steer", since: 1761200001000 },
          { peerId: "guest-tab-01", id: GUEST.id, kind: "guest", name: "Ada", surface: "web", role: "visitor", tier: "view", since: 1761200002000 },
        ],
      },
    },
    {
      name: "roster (guest)",
      to: "client",
      frame: {
        t: "rc.roster",
        scope: "guest",
        driverEpoch: 1,
        ownerOnline: true,
        driver: { kind: "user", name: null },
        you: "visitor",
        counts: { members: 2, visitors: 1 },
      },
    },
    { name: "owner offline", to: "client", frame: { t: "rc.owner", online: false, graceEndsAt: 1761200600000 } },
    { name: "owner online", to: "client", frame: { t: "rc.owner", online: true } },
    {
      name: "control request",
      to: "host",
      frame: {
        t: "rc.control_request",
        request: {
          requestId: FIXTURE_ULID,
          from: GUEST,
          status: "pending",
          requestedAt: 1761200003000,
          expiresAt: 1761200063000,
          answeredAt: null,
          reason: null,
        },
      },
    },
    {
      name: "command to the host",
      to: "host",
      frame: {
        t: "rc.command",
        commandId: FIXTURE_ULID,
        driverEpoch: 1,
        from: OWNER,
        command: { kind: "submit", content: "Run the tests again" },
      },
    },
    { name: "command result: ok", to: "client", frame: { t: "rc.command_result", commandId: FIXTURE_ULID, ok: true } },
    {
      name: "command result: pending (a resend)",
      to: "client",
      frame: { t: "rc.command_result", commandId: FIXTURE_ULID, ok: null, status: "pending" },
    },
    {
      name: "command result: refused by the relay",
      to: "client",
      frame: {
        t: "rc.command_result",
        commandId: FIXTURE_ULID,
        ok: false,
        refusedBy: "relay",
        gate: "owner_offline",
        code: "owner_offline",
        message: "the owner's desktop is offline",
      },
    },
    {
      name: "command result: refused by the relay, the owner while somebody else drives",
      to: "client",
      frame: {
        t: "rc.command_result",
        commandId: FIXTURE_ULID,
        ok: false,
        refusedBy: "relay",
        gate: "not_driver",
        code: "not_driver",
        message: "somebody else is driving; take over to steer",
        takeOver: true,
      },
    },
    {
      name: "command result: refused by the desktop",
      to: "client",
      frame: {
        t: "rc.command_result",
        commandId: FIXTURE_ULID,
        ok: false,
        refusedBy: "desktop",
        gate: "not_pending",
        code: "not_pending",
        message: "that prompt was already answered",
      },
    },
    {
      name: "command result: relay timeout",
      to: "client",
      frame: {
        t: "rc.command_result",
        commandId: FIXTURE_ULID,
        ok: false,
        refusedBy: "relay",
        code: "relay_timeout",
        message: "the desktop did not answer in time; it may still have acted",
      },
    },
    { name: "snapshot request", to: "host", frame: { t: "rc.snapshot_request", reason: "joiner" } },
    { name: "resync (host)", to: "client", frame: { t: "rc.resync", as_of_seq: 57, reason: "host" } },
    { name: "resync (ahead)", to: "client", frame: { t: "rc.resync", as_of_seq: 0, reason: "ahead" } },
    { name: "resync (lagging)", to: "client", frame: { t: "rc.resync", as_of_seq: 40, reason: "lagging" } },
    { name: "closed", to: "client", frame: { t: "rc.closed", reason: "closed_by_owner" } },
    {
      name: "refused",
      to: "client",
      frame: { t: "rc.refused", ref: FIXTURE_ULID, code: "rate_limited", message: "slow down" },
    },
    {
      name: "refused (cooldown)",
      to: "client",
      frame: { t: "rc.refused", code: "cooldown", message: "wait before asking again", retryAt: 1761200093000 },
    },
    {
      name: "error",
      to: "host",
      frame: { t: "rc.error", code: "protocol_unsupported", message: "this server speaks rc protocol 1" },
    },
  ],
};
```

**Files.** `packages/contracts/fixtures/rc-frames-v1.json` is exactly `JSON.stringify(RC_FRAME_FIXTURES, null, 2) + "\n"`; `packages/contracts/fixtures/rc-wire-v1.json` is exactly `JSON.stringify(RC_WIRE_FIXTURES, null, 2) + "\n"`. Regenerate both whenever the module changes; there is no build step that writes them.

**What pins them.** `apps/ingest/test/rc-wire.test.ts`: every wire fixture round-trips through `encodeRcFrame`/`decodeRcFrame` to the stated `hex` and, where `envelopes` is given, splits with `decodeRcDeltaBatch` and rebuilds with `encodeRcDeltaBatch` to the same bytes; `rc-wire-v1.json` must `toEqual` `RC_WIRE_FIXTURES`; `rc-frames-v1.json` must equal `RC_FRAME_FIXTURES` structurally **and** `JSON.stringify(framesFile, null, 2)` must equal `JSON.stringify(RC_FRAME_FIXTURES, null, 2)` byte for byte; `RC_WIDENING_MODE_WORDS` must equal the ten words above in order and `framesFile.constants.RC_WIDENING_MODE_WORDS` must equal it; every `toServer` example must parse with `RcInboundControl` and every `fromServer` example with `RcServerControl`; and both directions must cover every frame `t`. The desktop holds byte-identical copies at `crates/atlas-remote-control/tests/fixtures/rc-frames-v1.json` and `rc-wire-v1.json`, read by `tests/contract.rs` through `include_str!`, round-tripped through its serde types and its own codec; the copies are verified identical to the server's today. Changing either side without the other fails a test on one of them.

*Reference implementation:* `packages/contracts/src/rc.ts`, `packages/contracts/fixtures/rc-frames-v1.json`, `packages/contracts/fixtures/rc-wire-v1.json`, `apps/ingest/test/rc-wire.test.ts`.

## 3. Storage

### 3.1 D1 migration

`packages/db/migrations/0045_rc_rooms.sql`, verbatim:

```sql
-- Universal RC: one row per remotely-controlled live desktop Session, and the
-- members invited into it. A room belongs to an *account* (owner_user_id);
-- org_id and workspace_id are its nullable, set-once multiplayer scope — NULL
-- is a solo room, and the pair goes back to NULL when the owner leaves the
-- Organisation or it is deleted (the room continues solo). The room's Durable
-- Object is the authority on everything mutable; these rows are a directory,
-- never trusted for access on their own. host_online mirrors the object's
-- host socket as the desktop connects and leaves, so a list draws the status
-- dot without waking a room. RC links and the org_settings policy columns
-- come with public links, in a later migration.
CREATE TABLE `rc_members` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`invited_by` text NOT NULL,
	`invited_at` integer NOT NULL,
	`joined_at` integer,
	`emailed_at` integer,
	PRIMARY KEY(`room_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `rc_members_by_user` ON `rc_members` (`user_id`,`joined_at`);--> statement-breakpoint
CREATE TABLE `rc_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`workspace_id` text,
	`session_id` text NOT NULL,
	`native_session_id` text,
	`owner_user_id` text NOT NULL,
	`owner_client_id` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`title` text,
	`member_tier` text DEFAULT 'view' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`host_online` integer DEFAULT 0 NOT NULL,
	`end_reason` text,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	`purge_at` integer,
	CONSTRAINT "rc_rooms_status" CHECK(status IN ('open', 'ended')),
	CONSTRAINT "rc_rooms_tier" CHECK(member_tier IN ('view', 'steer', 'steer_approve'))
);
--> statement-breakpoint
CREATE INDEX `rc_rooms_by_owner` ON `rc_rooms` (`owner_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `rc_rooms_by_org` ON `rc_rooms` (`org_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `rc_rooms_open_session` ON `rc_rooms` (`owner_user_id`,`session_id`) WHERE status = 'open';
```

The migration runs against the shared `atlas-auth` D1 (`ROUTING_DB` in ingest). The file has no trailing newline after the last statement.

**`rc_rooms`** — a directory, never the authority; written by the create door (insert), the PATCH door (scope and settings), the room's object (status, `host_online`, `end_reason`, `ended_at`, `purge_at`, the scope back to NULL, and the delete on purge).

| column | type | null | meaning / who writes it |
| --- | --- | --- | --- |
| `id` | text PK | no | ULID minted by the create door. The object's name is `rc:{id}`. |
| `org_id` | text | yes | The scope's Organisation. NULL = solo. Create door (insert), PATCH door (set once over NULL), object (back to NULL on revocation). |
| `workspace_id` | text | yes | The scope's registered project; meaningful only when `org_id` is set. Same writers. |
| `session_id` | text | no | The desktop-minted Session id. |
| `native_session_id` | text | yes | The agent's own session id; informational, never routes anything. |
| `owner_user_id` | text | no | The creating token's `sub`; the only authority on who may open, host, list, manage and close. |
| `owner_client_id` | text | no | The one desktop that may host (`RcClientId`). |
| `agent` | text | no | The agent id the desktop named. |
| `model` | text | yes | The model the desktop named. |
| `title` | text | yes | At most 80 characters; `""` is stored as NULL. Create door and PATCH door. |
| `member_tier` | text | no, default `'view'` | `view`, `steer` or `steer_approve`; checked by `rc_rooms_tier`. Create door and PATCH door. |
| `capabilities` | text | no, default `'[]'` | JSON array of `RcCapability`. Create door. |
| `status` | text | no, default `'open'` | `open` or `ended`; checked by `rc_rooms_status`. Set to `ended` by the object and only there. |
| `host_online` | integer | no, default `0` | `1` while the object holds the host socket; written by the object when the host connects and leaves (never per frame); `0` once ended. |
| `end_reason` | text | yes | One of `RC_END_REASONS`; object. |
| `created_at` | integer | no | Epoch ms; create door. |
| `ended_at` | integer | yes | Epoch ms; object. |
| `purge_at` | integer | yes | When the rows and the object's storage go: `ended_at + 7 days`, or `ended_at` for `erased`; object. |

| index | columns | purpose |
| --- | --- | --- |
| `rc_rooms_by_owner` | `(owner_user_id, status, created_at)` | The per-account open-rooms count on the create door and the owner half of the list. |
| `rc_rooms_by_org` | `(org_id, status)` | The scope-revocation fan-out (`SELECT id FROM rc_rooms WHERE org_id = ? AND status = 'open'`) and the erasure lookup. |
| `rc_rooms_open_session` (unique, partial) | `(owner_user_id, session_id) WHERE status = 'open'` | **At most one open room per owner and Session.** It is what makes a repeated `POST /rc/rooms` idempotent rather than a second room, even when two creates land at once: the second insert fails, the create door ends the orphan object and answers the winner. A room that has ended frees the pair. |

**`rc_members`** — who besides the owner may join. Read once when a member's socket connects and on the REST doors, never per frame. No door writes it in this cut.

| column | type | null | meaning |
| --- | --- | --- | --- |
| `room_id` | text | no | PK with `user_id`. |
| `user_id` | text | no | The invited account. |
| `invited_by` | text | no | The inviting account. |
| `invited_at` | integer | no | Epoch ms. |
| `joined_at` | integer | yes | Their first socket; NULL while pending. Never written in this cut. |
| `emailed_at` | integer | yes | When the one invite mail was sent. Never written in this cut. |

| index | columns | purpose |
| --- | --- | --- |
| `rc_members_by_user` | `(user_id, joined_at)` | A person's invites, pending first, for the member half of the list (`id IN (SELECT room_id FROM rc_members WHERE user_id = ?)`). |

### 3.2 Drizzle schema, journal, snapshot

Appended to `packages/db/src/schema.ts`, verbatim:

```ts
// ---------------------------------------------------------------------------
// Universal RC — remote control of a live desktop agent session
// ---------------------------------------------------------------------------

export const rcRooms = sqliteTable(
  "rc_rooms",
  {
    /** ULID, minted by the create door. */
    id: text("id").primaryKey(),
    /** The scope's Organisation, or NULL for a solo room. Set once. */
    orgId: text("org_id"),
    /** The scope's registered project, or NULL (a solo room, or one that never left Local mode). */
    workspaceId: text("workspace_id"),
    /** The desktop-minted Session id; one open room per owner and Session. */
    sessionId: text("session_id").notNull(),
    /** The agent's own session id. Informational; never routes anything. */
    nativeSessionId: text("native_session_id"),
    ownerUserId: text("owner_user_id").notNull(),
    /** The one desktop that may host: its stable replica id. */
    ownerClientId: text("owner_client_id").notNull(),
    agent: text("agent").notNull(),
    model: text("model"),
    /** The first 80 characters of the opening prompt; never shown to a link visitor. */
    title: text("title"),
    /** `view`, `steer` or `steer_approve`: what invited members may do. */
    memberTier: text("member_tier").notNull().default("view"),
    /** What the desktop said it would honour, as a JSON array. */
    capabilities: text("capabilities").notNull().default("[]"),
    /** `open` or `ended`. Set to `ended` by the room's object, and only there. */
    status: text("status").notNull().default("open"),
    hostOnline: integer("host_online").notNull().default(0),
    /** Why it ended — `closed_by_owner`, `owner_timeout`, `never_hosted`, … */
    endReason: text("end_reason"),
    createdAt: integer("created_at").notNull(),
    endedAt: integer("ended_at"),
    /** When an ended room's rows and object storage go (`ended_at` + 7 days). */
    purgeAt: integer("purge_at"),
  },
  (table) => [
    index("rc_rooms_by_owner").on(table.ownerUserId, table.status, table.createdAt),
    index("rc_rooms_by_org").on(table.orgId, table.status),
    uniqueIndex("rc_rooms_open_session")
      .on(table.ownerUserId, table.sessionId)
      .where(sql`status = 'open'`),
    check("rc_rooms_status", sql`status IN ('open', 'ended')`),
    check("rc_rooms_tier", sql`member_tier IN ('view', 'steer', 'steer_approve')`),
  ],
);

export const rcMembers = sqliteTable(
  "rc_members",
  {
    roomId: text("room_id").notNull(),
    userId: text("user_id").notNull(),
    invitedBy: text("invited_by").notNull(),
    invitedAt: integer("invited_at").notNull(),
    /** Their first socket; NULL while the invite is pending. */
    joinedAt: integer("joined_at"),
    /** When the one invite mail was sent: never a second per room and person. */
    emailedAt: integer("emailed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index("rc_members_by_user").on(table.userId, table.joinedAt),
  ],
);
```

`packages/db/migrations/meta/_journal.json` gains one entry after `0044_gpt6_models`:

```json
    {
      "idx": 45,
      "version": "6",
      "when": 1792733940335,
      "tag": "0045_rc_rooms",
      "breakpoints": true
    }
```

`packages/db/migrations/meta/0045_snapshot.json` must exist and describe the schema after the migration. Both the SQL and the snapshot are produced by `pnpm --filter @atlas/db generate` (`drizzle-kit generate`) from the schema above; the SQL file's leading comment block is then added by hand. A journal entry without its snapshot, or a snapshot that disagrees with `schema.ts`, makes the next `generate` emit a spurious diff.

### 3.3 The feature catalogue entry

In `packages/contracts/src/features.ts`, `"rc.enabled"` is appended to `PLATFORM_FEATURES` (after `"threads.remote_run"`) and six keys to `FEATURE_LIMIT_KEYS` (after `"base_bundle_bytes"`):

```ts
  // Universal RC (`rc.enabled`).
  "rc_rooms",
  "rc_participants",
  "rc_links",
  "rc_tail_bytes",
  "rc_offline_grace_ms",
  "rc_command_burst",
```

The catalogue entry, verbatim (`MiB` is the module's existing `1024 * 1024`):

```ts
  "rc.enabled": {
    label: "Remote control",
    description:
      "Watch and steer a live desktop agent session from the web, a phone or another desktop. The platform switch governs everybody's own rooms; an Organisation's grant governs inviting its members into a room (one driver, any number of visitors). A member's own rooms need only the platform switch.",
    globalDefault: true,
    orgDefault: false,
    limits: {
      rc_rooms: {
        label: "Open rooms per person",
        description: "Live remotely-controlled sessions one member may host at once.",
        default: 3,
        unit: "count",
        min: 1,
        max: 50,
      },
      rc_participants: {
        label: "Participants per room",
        description: "Invited members plus connected link visitors in one room.",
        default: 12,
        unit: "count",
        min: 1,
        max: 100,
      },
      rc_links: {
        label: "Live links per room",
        description: "Unrevoked, unexpired links one room may have.",
        default: 5,
        unit: "count",
        min: 1,
        max: 50,
      },
      rc_tail_bytes: {
        label: "Catch-up buffer",
        description: "Bytes of recent stream the room keeps in memory for a late joiner.",
        default: 2 * MiB,
        unit: "bytes",
        min: 256 * 1024,
        max: 8 * MiB,
      },
      rc_offline_grace_ms: {
        label: "Owner-offline grace (ms)",
        description: "How long a room stays open after the desktop disappears, in milliseconds.",
        default: 3_600_000,
        unit: "count",
        min: 30_000,
        max: 14_400_000,
      },
      rc_command_burst: {
        label: "Command burst",
        description: "Steering commands one driver may send in a burst (refills at 2 per second).",
        default: 10,
        unit: "count",
        min: 1,
        max: 100,
      },
    },
  },
```

| key | default | min | max | unit | meaning | whose number on a socket |
| --- | --- | --- | --- | --- | --- | --- |
| `rc_rooms` | 3 | 1 | 50 | count | Open rooms one account may host at once, counted per account across every Organisation and none. | account (platform default) |
| `rc_participants` | 12 | 1 | 100 | count | Invited members plus connected link visitors in one room. | **scope Organisation** on a member socket; account on an owner socket |
| `rc_links` | 5 | 1 | 50 | count | Live links per room (unused in this cut). | **scope Organisation** on a member socket; account on an owner socket |
| `rc_tail_bytes` | 2 097 152 | 262 144 | 8 388 608 | bytes | The ring's byte bound. Read at `/init`; the room keeps the value it was created with. | account |
| `rc_offline_grace_ms` | 3 600 000 | 30 000 | 14 400 000 | count | How long a room stays open after the host disappears. Read at `/init`. | account |
| `rc_command_burst` | 10 | 1 | 100 | count | The steering-command bucket's burst; refill is `RC_COMMAND_PER_SECOND`. | account |

`globalDefault: true` means a fresh deployment, with no `platform_feature_flags` row, has remote control on for every account. `orgDefault: false` means no Organisation's members may be invited until Ops writes an `org_feature_overrides` row (or a billing plan grants it). **The account's limits are the catalogue defaults, always** — there is no per-account grant in this cut. The gate helpers the doors use are the existing `featureLayers(rows, feature)` (the global layer's answer `?? globalDefault`; the Organisation layer's answer `?? plan ?? orgDefault`), `featureAccessFromRows(rows)` and `featureLimit(access, feature, key)`, reading the rows of `FEATURE_SET_SQL`:

```sql
SELECT '' AS org_id, feature, enabled, NULL AS limits_json FROM platform_feature_flags
  UNION ALL
  SELECT org_id, feature, enabled, limits_json FROM org_feature_overrides WHERE org_id = ?1
  UNION ALL
  SELECT '*plan' AS org_id, j.key AS feature,
      json_extract(j.value, '$.enabled') AS enabled,
      json_extract(j.value, '$.limits') AS limits_json
    FROM billing_plan p,
      json_each(CASE WHEN json_valid(p.features_json) THEN p.features_json ELSE '{}' END) j
    WHERE p.id = COALESCE(
    (SELECT op.plan_id FROM org_plan op
      WHERE op.org_id = ?1
        AND (op.effective_until IS NULL OR op.effective_until > CAST(unixepoch('subsecond') * 1000 AS INTEGER))
      ORDER BY CASE op.source WHEN 'manual' THEN 0 ELSE 1 END
      LIMIT 1),
    (SELECT d.id FROM billing_plan d WHERE d.is_default = 1 ORDER BY d.sort, d.id LIMIT 1))
```

The catalogue snapshot tests in `apps/auth/test/features.test.ts` and `apps/chat/test/features.test.ts` change with the entry.

*Reference implementation:* `packages/db/migrations/0045_rc_rooms.sql`, `packages/db/src/schema.ts`, `packages/contracts/src/features.ts`.

## 4. REST doors (`apps/ingest/src/rc.ts`)

### 4.0 Common to every REST door

**Routing.** In `apps/ingest/src/index.ts`, `isRcSocketPath(path)` (`/rc/host/ws` or `/rc/ws`) is answered **before** the bearer check by `serveRcSocket` (§5). Every other `/rc` path (`isRcPath`: `path === "/rc" || path.startsWith("/rc/")`) is answered after the bearer check by `serveRc(req, env, claims)`.

**Bearer.** The front door reads `Authorization: Bearer <jwt>`; absent → `401 unauthorized` "missing bearer token"; verification against the JWKS (`verifyAccessToken(token, envVerifyConfig(env))`, env `AUTH_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`) fails → `401 unauthorized` "invalid or expired token". `claims.sub` is the caller; `claims.orgs` (`Record<orgId, Role>`, may be absent or `{}`) is read only by the scope checks.

**Inside `serveRc`, in order:**

1. Rate limit, key `rc:{claims.sub}`, against the `RATE_LIMIT` binding (`simple: { limit: 600, period: 60 }`); exceeded → `429 rate_limited` "too many requests; slow down" with header `retry-after: 60`. The limiter **fails open**: an error from the binding counts as not exceeded.
2. The caller is `{ userId: claims.sub, claims, orgHint: url.searchParams.get("org") }`. `?org=` is **never an authorisation input**: it filters the list and shapes the features hint, nothing else.
3. Route on `url.pathname.split("/").filter(s => s !== "")`:

| segments | method | door | other methods |
| --- | --- | --- | --- |
| `rc`, `features` | GET | §4.1 | `405` with `allow: GET` |
| `rc`, `rooms` | POST / GET | §4.2 / §4.3 | `405` with `allow: GET, POST` |
| `rc`, `rooms`, `{id}` | GET / PATCH | §4.4 / §4.5 | `405` with `allow: GET, PATCH` |
| `rc`, `rooms`, `{id}`, `close` | POST | §4.6 | `405` with `allow: POST` |
| anything else | — | `404 not_found` "no such route" | — |

A `405` is a plain-text body `method not allowed` with the `allow` header; every other refusal is the JSON envelope `{ error: { code, message } }`, `403 rc_refused` adding `gate`.

**Shared helpers**, as rules:

- `ROOM_COLUMNS` = `id, org_id, workspace_id, session_id, owner_user_id, owner_client_id, agent, model, title, member_tier, capabilities, status, host_online, end_reason, created_at, ended_at`.
- `roomById(id)`: `SELECT ${ROOM_COLUMNS} FROM rc_rooms WHERE id = ?1`.
- `isInvited(roomId, userId)`: `SELECT 1 AS n FROM rc_members WHERE room_id = ?1 AND user_id = ?2` → row exists.
- `adminOf(caller, row)`: `row.org_id !== null && claims.orgs?.[row.org_id] === "admin"`. Never true for a solo room.
- `roomOf(row, live)` builds an `RcRoom`: `capabilities` is `JSON.parse(row.capabilities)` filtered to strings, `[]` on any parse failure; `driverEpoch` is `live.driverEpoch` or `null`; `hostOnline` is `live.hostOnline` when the object was asked, else `row.status === "open" && row.host_online === 1`.
- `ACCOUNT_LIMITS`: every `RC_LIMIT_KEYS` key at `FEATURE_CATALOGUE["rc.enabled"].limits[key].default`.
- `platformAccess()`: run `SELECT '' AS org_id, feature, enabled, NULL AS limits_json FROM platform_feature_flags WHERE feature = 'rc.enabled'`; `layers = featureLayers(rows, "rc.enabled")`; answer `{ gate: layers.global ? null : "platform_flag", limits: ACCOUNT_LIMITS }`.
- `orgAccess(orgId)`: run `FEATURE_SET_SQL` bound to `orgId`; `layers = featureLayers(rows, "rc.enabled")`; `features = featureAccessFromRows(rows)`; `gate = !layers.global ? "platform_flag" : !layers.org ? "org_setting" : null`; `limits = gate === null ? limitsOf(features) : null`, where `limitsOf` is `null` unless `features.features["rc.enabled"]` and otherwise every key via `featureLimit(features, "rc.enabled", key)`.
- `memberLimits(org)`: `{ ...ACCOUNT_LIMITS, rc_participants: org.rc_participants, rc_links: org.rc_links }`.
- `refused(gate)`: `403` with body `{ error: { code: "rc_refused", message }, gate }` where the message is `platform_flag` → `"Remote control is turned off on this platform"`, `org_setting` → `"Remote control for this organisation's members is not turned on. Ask an Atlas admin to enable it; your own rooms still work."`.
- `validScope(caller, scope)`, in order: (1) `claims.orgs?.[scope.orgId] === undefined` → `403 forbidden` "not a member of that organisation"; (2) `orgAccess(scope.orgId)`: `gate !== null || limits === null` → `refused(gate ?? "org_setting")`; (3) `scope.workspaceId !== null`: `workspaceById(env, scope.orgId, scope.workspaceId)` (`workspace_refs` joined to its handle, `WHERE w.id = ? AND w.org_id = ?`) is `null`, or `mayRead(env, ws, caller.userId)` is `false` (archived → false; visibility `org` → true; `created_by === userId` → true; else a `workspace_members` row) → `404 not_found` "no such workspace"; else `null`.
- `rcStub(roomId)`: `env.RC_DO.get(env.RC_DO.idFromName(`rc:${roomId}`))`.
- `objectHeaders(userId, roomId, admin = false)`: a `Headers` with `content-type: application/json`, `X-Atlas-User-Id: {userId}`, `X-Atlas-Rc-Room: {roomId}`, and `X-Atlas-Rc-Org-Admin: 1` only when `admin`.
- `liveView(row)`: `GET https://rc/view` on the stub with `objectHeaders(row.owner_user_id, row.id)`; the JSON `RcRoomView` on `ok`, else `null`; a thrown error is `null`.
- `visibleRoom(caller, roomId, adminManages = false)`: `row = roomById(roomId)`; `null` → `null`; `owner = row.owner_user_id === caller.userId`; `invited = !owner && isInvited(row.id, caller.userId)`; `admin = adminOf(caller, row)`; `!owner && !invited && !(adminManages && admin)` → `null`; else `{ row, owner, invited, admin }`. The `null` is always answered `404 not_found` "no such room": unknown, not yours, and an uninvited admin on a door that is not management are indistinguishable.

**The object's REST doors**, which the doors above call over `stub.fetch(new Request("https://rc/<door>", …))`. Before any of them except `/init`, the object checks, in order: its stored `room_id` is set, equals the request's `X-Atlas-Rc-Room`, and `X-Atlas-User-Id` is non-empty, else `404 not_found` "no such room"; the user is not in its `revoked_members` tombstones, else `404 not_found` "no such room".

| door | body | success | refusals, in order |
| --- | --- | --- | --- |
| `POST /init` | `RcInit` (§4.2 step 8) | `201 { driverEpoch: 1 }` | body fails `RcInit` → `400 bad_request` "malformed room init"; already initialised → `409 rc_closed` "room already exists" |
| `GET /view` | — | `200 RcRoomView` = `{ status, hostOnline, driverEpoch, driver, sockets }` | the two common checks only |
| `POST /settings` | `{ memberTier?, acceptRequests?, title? }` | `200 { memberTier, acceptRequests }` | status not `open` → `409 rc_closed` "this room has ended"; user ≠ owner → `403 rc_not_owner` "only the room owner may change it" |
| `POST /scope` | `{ orgId, workspaceId }` | `200 { orgId, workspaceId }` | status not `open` → `409 rc_closed` "this room has ended"; user ≠ owner → `403 rc_not_owner` "only the room owner may change it"; body null or `orgId` not a non-empty string → `400 bad_request` "name the scope's orgId"; scope already set and **identical** (same `orgId`, same `workspaceId ?? null`) → `200` with the stored pair (idempotent); already set and different → `409 rc_scope_set` "this room's scope is set already" |
| `POST /close` | `{ reason?: RcEndReason }` (passthrough) | `204` | user ≠ owner and header `X-Atlas-Rc-Org-Admin` ≠ `"1"` → `403 rc_not_owner` "only the room owner or an admin may close it" |

`/close` derives the reason itself: `reason === "erased"` → `erased`; else user is the owner → `closed_by_owner`; else → `closed_by_admin`. The audit detail carries `{ admin: true }` when the header was set. Ending an already-ended room is a no-op `204`.

### 4.1 `GET /rc/features[?org=]`

- **Who may call:** anyone signed in. **Auth source:** `claims.sub` (not used beyond the rate limit). **`?org=`:** optional; selects which Organisation the `multiplayer` half describes; never a refusal.
- **Request:** no body; query `org` optional.
- **Steps:**
  1. `platform = platformAccess()`.
  2. `multiplayer = null`. If `orgHint !== null`: if `claims.orgs?.[orgHint] === undefined` → `multiplayer = { enabled: false, limits: null }` (an Organisation the caller is not in can invite nobody for them; this is **not** a `403`); else `org = orgAccess(orgHint)` and `multiplayer = { enabled: org.gate === null && org.limits !== null, limits: org.limits }`.
  3. Answer `200` with header `cache-control: no-store`.
- **Response:**

```json
{
  "enabled": true,
  "limits": { "rc_rooms": 3, "rc_participants": 12, "rc_links": 5, "rc_tail_bytes": 2097152, "rc_offline_grace_ms": 3600000, "rc_command_burst": 10 },
  "multiplayer": null,
  "publicLinks": false,
  "passwordRequired": false,
  "turnstileConfigured": true
}
```

`enabled` is `platform.gate === null`; `limits` is `platform.limits` when enabled, else `null`; `multiplayer` is as above (`null` without `?org=`; `{ enabled: true, limits: {…the Organisation's effective limits…} }` for a granted Organisation; `{ enabled: false, limits: null }` otherwise); `publicLinks` and `passwordRequired` are the literals `false`; `turnstileConfigured` is `Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY)`.

### 4.2 `POST /rc/rooms`

- **Who may call:** anyone signed in; only a desktop does (the web proxy does not forward it). **Auth source:** `claims.sub` becomes `owner_user_id`. **`?org=`:** ignored.
- **Request:** JSON body `CreateRcRoomRequest` (strict). `content-type` is not checked.
- **Steps:**
  1. `req.json()` throws → `400 bad_request` "body is not JSON".
  2. `CreateRcRoomRequest.safeParse` fails → `400 bad_request` "name the sessionId, clientId, agent and capabilities (and nothing else)".
  3. `platformAccess()`; `gate !== null` → `refused("platform_flag")`.
  4. **Idempotent lookup.** `SELECT ${ROOM_COLUMNS} FROM rc_rooms WHERE owner_user_id = ?1 AND session_id = ?2 AND status = 'open'` bound to `(claims.sub, body.sessionId)`. A row → `200 { room: roomOf(row, liveView(row)), hostSecret: null }`. The secret is **never re-issued**: re-issuing it would hand it to anybody holding the owner's token. A desktop that has lost it closes the room and creates another. Whatever Organisation the desktop is pinned to meanwhile is irrelevant: the key is `(owner, session)`.
  5. **Per-account open-room count.** `SELECT count(*) AS n FROM rc_rooms WHERE owner_user_id = ?1 AND status = 'open'`; `n >= limits.rc_rooms` → `409 limit_reached` with message `` `You already host ${n} open rooms, the most your account allows (Open rooms per person: ${limits.rc_rooms}).` `` Counted across every Organisation and none.
  6. `body.scope !== null` → `validScope(caller, body.scope)`; a response → return it (`403 forbidden`, `403 rc_refused { gate }`, or `404 not_found` "no such workspace").
  7. `hostSecret = randomHex(32)` — 32 bytes from `crypto.getRandomValues`, lower-case hex, 64 characters. `roomId = ulid()`. `at = Date.now()`.
  8. Build `RcInit`:

```ts
{
  orgId: body.scope?.orgId ?? null,
  workspaceId: body.scope?.workspaceId ?? null,
  roomId,
  ownerUserId: claims.sub,
  ownerClientId: body.clientId,
  hostSecretHash: await sha256Hex(hostSecret),   // hex SHA-256 of the UTF-8 bytes of the 64-hex string
  memberTier: body.memberTier,
  capabilities: body.capabilities,
  agent: body.agent,
  model: body.model ?? null,
  limits,                                        // ACCOUNT_LIMITS
  at,
}
```

  9. **Create and place the object.** `stub = rcStub(roomId)`. This `get()` is the first on the name `rc:{roomId}`, so the object is placed near the colo that served this request — the one nearest the desktop that will stream into it — and never moves. Only the create door may be first: every other door reads the row first, which exists only after this step. `POST https://rc/init` with header `content-type: application/json` and the `RcInit` body (no user or room header). A thrown error, or a non-`ok` response → `503 unavailable` "the room could not be created; try again".
  10. **Insert the row:**

```sql
INSERT INTO rc_rooms (id, org_id, workspace_id, session_id, native_session_id, owner_user_id,
  owner_client_id, agent, model, title, member_tier, capabilities, status, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'open', ?13)
```

bound to `(roomId, init.orgId, init.workspaceId, body.sessionId, body.nativeSessionId ?? null, claims.sub, body.clientId, body.agent, body.model ?? null, body.title === undefined || body.title === "" ? null : body.title, body.memberTier, JSON.stringify(body.capabilities), at)`. If the insert throws (the unique index: two creates for one Session raced and the other landed first): `POST https://rc/close` on the stub with `objectHeaders(claims.sub, roomId)` and body `{"reason":"closed_by_owner"}` (errors ignored — the object ends itself `never_hosted` within a minute regardless); re-run the step-4 lookup; a row → `200 { room, hostSecret: null }`; none → log `{ rc_room_insert_failed, roomId }` and `503 unavailable` "the room could not be created; try again".
  11. `roomById(roomId)` is `null` → `503 unavailable` "the room could not be read back; try again".
  12. `201` with `{ room: roomOf(row, { status: "open", hostOnline: false, driverEpoch: 1, driver: { id: claims.sub, kind: "user", name: null }, sockets: 0 }), hostSecret }`.

- **Response (`201`):**

```json
{
  "room": {
    "id": "01JB8Z5G7Q2W3E4R5T6Y7V8X9Z",
    "orgId": null,
    "workspaceId": null,
    "sessionId": "ses-a1b2c3d4",
    "agent": "atlas-agent",
    "model": "claude-opus-5",
    "title": "Fix the flaky test",
    "ownerUserId": "user_owner",
    "memberTier": "view",
    "capabilities": ["steer", "approve", "mode", "model", "config"],
    "status": "open",
    "driverEpoch": 1,
    "hostOnline": false,
    "createdAt": 1761200000000,
    "endedAt": null,
    "endReason": null
  },
  "hostSecret": "9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b"
}
```

The idempotent `200` has the same shape with `"hostSecret": null` and `driverEpoch`/`hostOnline` from the object (`null`/row mirror if the object could not be reached).

### 4.3 `GET /rc/rooms[?org=]`

- **Who may call:** anyone signed in. **Auth source:** `claims.sub`. **`?org=`:** optional filter on `org_id`; a stale or foreign value simply matches no rows.
- **Steps:**
  1. Query:

```sql
SELECT ${ROOM_COLUMNS} FROM rc_rooms
 WHERE (owner_user_id = ?1 OR id IN (SELECT room_id FROM rc_members WHERE user_id = ?1))
   AND (?2 IS NULL OR org_id = ?2)
 ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC, id DESC
 LIMIT ?3
```

bound to `(claims.sub, orgHint, 201)`.
  2. `notes = []`; more than 200 rows → push `"only the newest 200 rooms are listed"`.
  3. `200 { rooms: rows.slice(0, 200).map(r => roomOf(r, null)), notes }`. **A list never wakes a room**: `driverEpoch` is `null` on every row and `hostOnline` is the directory mirror.
- **Response:**

```json
{
  "rooms": [
    { "id": "…", "orgId": "org_01", "workspaceId": null, "sessionId": "…", "agent": "atlas-agent", "model": null, "title": null, "ownerUserId": "user_owner", "memberTier": "steer", "capabilities": ["steer"], "status": "open", "driverEpoch": null, "hostOnline": true, "createdAt": 1761200000000, "endedAt": null, "endReason": null },
    { "id": "…", "orgId": null, "workspaceId": null, "sessionId": "…", "agent": "claude-code", "model": "claude-sonnet-5", "title": "Refactor", "ownerUserId": "user_owner", "memberTier": "view", "capabilities": [], "status": "ended", "driverEpoch": null, "hostOnline": false, "createdAt": 1761100000000, "endedAt": 1761190000000, "endReason": "closed_by_owner" }
  ],
  "notes": []
}
```

### 4.4 `GET /rc/rooms/{id}`

- **Who may call:** the owner or an invited member; an admin of the scope Organisation who was not invited is `404`. **`?org=`:** ignored.
- **Steps:**
  1. `visibleRoom(caller, id)` is `null` → `404 not_found` "no such room".
  2. `live = liveView(row)` is `null` → `503 unavailable` "the room could not be reached".
  3. `SELECT user_id, invited_by, invited_at, joined_at FROM rc_members WHERE room_id = ?1 ORDER BY invited_at, user_id`.
  4. `200 { room: roomOf(row, live), members }`.
- **Response:**

```json
{
  "room": { "id": "…", "orgId": "org_01", "workspaceId": "01JB8Z5G7Q2W3E4R5T6Y7V8WS1", "sessionId": "…", "agent": "atlas-agent", "model": "claude-opus-5", "title": "Fix the flaky test", "ownerUserId": "user_owner", "memberTier": "steer", "capabilities": ["steer", "approve", "mode", "model", "config"], "status": "open", "driverEpoch": 2, "hostOnline": true, "createdAt": 1761200000000, "endedAt": null, "endReason": null },
  "members": [
    { "userId": "user_member", "invitedBy": "user_owner", "invitedAt": 1761200001000, "joinedAt": null }
  ]
}
```

This door wakes the room; the live page never polls it.

### 4.5 `PATCH /rc/rooms/{id}`

- **Who may call:** the owner only. An invited member is told so; anyone else sees nothing. **`?org=`:** ignored.
- **Request:** JSON body `UpdateRcRoomRequest` (strict; at least one field).
- **Steps:**
  1. `req.json()` throws → `400 bad_request` "body is not JSON".
  2. `visibleRoom(caller, id)` is `null` → `404 not_found` "no such room".
  3. `!owner` → `403 rc_not_owner` "only the room owner may change it".
  4. `row.status !== "open"` → `409 rc_closed` "this room has ended".
  5. `UpdateRcRoomRequest.safeParse` fails → `400 bad_request` "change memberTier, title, acceptRequests or scope".
  6. **Scope, set once**, when `scope` is present:
     1. `row.org_id !== null` → `409 rc_scope_set` "this room's scope is set already".
     2. `validScope(caller, scope)`; a response → return it.
     3. **The directory row is the lock:** `UPDATE rc_rooms SET org_id = ?1, workspace_id = ?2 WHERE id = ?3 AND org_id IS NULL AND status = 'open'` bound to `(scope.orgId, scope.workspaceId, id)`. `meta.changes !== 1` → `409 rc_scope_set` "this room's scope is set already" (a concurrent PATCH won).
     4. `POST https://rc/scope` on the stub with `objectHeaders(claims.sub, id)` and body `{ "orgId": scope.orgId, "workspaceId": scope.workspaceId }`. A thrown error counts as no response.
     5. No response, or not `ok` → **roll back** with `UPDATE rc_rooms SET org_id = NULL, workspace_id = NULL WHERE id = ?1 AND org_id = ?2` bound to `(id, scope.orgId)` — over this scope only — and return the object's response as-is, or `503 unavailable` "the room could not be reached" when there was none. The next PATCH is then a retry, not a `409`. The object takes the identical scope twice as once, so a PATCH whose answer was lost lands on the retry.
  7. **Settings**, when any of `memberTier`, `title`, `acceptRequests` is present:
     1. `POST https://rc/settings` on the stub with `objectHeaders(claims.sub, id)` and body `{ memberTier?, title?, acceptRequests? }` (exactly the present fields). Thrown → `503 unavailable` "the room could not be reached". Not `ok` → return the object's response as-is. The object re-badges open member sockets in place first (a tier lowered below `steer` takes the seat from a member driving on it) and queues the roster on its tick.
     2. `title` normalised: absent → leave alone; `""` → `null`; else the string. `UPDATE rc_rooms SET member_tier = COALESCE(?1, member_tier), title = CASE WHEN ?2 = 1 THEN ?3 ELSE title END WHERE id = ?4` bound to `(memberTier ?? null, title present ? 1 : 0, title ?? null, id)`.
  8. Return the result of §4.4 for the same caller and room: `200 RcRoomResponse` (or its `503`).
- **Response:** as §4.4.

### 4.6 `POST /rc/rooms/{id}/close`

- **Who may call:** the owner, or an **admin of the room's scope Organisation** (`claims.orgs[row.org_id] === "admin"`), who may close a room they may not watch. A solo room has no admin. An admin of a different Organisation is `404`. **`?org=`:** ignored.
- **Request:** no body is read.
- **Steps:**
  1. `visibleRoom(caller, id, true)` is `null` → `404 not_found` "no such room".
  2. `!owner && !admin` (an invited member) → `403 rc_not_owner` "only the room owner or an admin may close it".
  3. `row.status !== "open"` → `204` (idempotent).
  4. `POST https://rc/close` on the stub with `objectHeaders(claims.sub, id, admin)` — the `X-Atlas-Rc-Org-Admin: 1` header is stamped exactly when the caller is not the owner and is an admin — and body `{ "reason": owner ? "closed_by_owner" : "closed_by_admin" }`. Not `ok` → return the object's response as-is. Thrown → `503 unavailable` "the room could not be reached".
  5. `204` with no body.

The object sends every socket `rc.closed { reason }`, closes each `4410`, drops the tail, snapshot and commands, declines open control requests with reason `room_closed`, writes `status = 'ended'`, `ended_at`, `end_reason`, `purge_at = ended_at + RC_ROOM_RETENTION_MS`, `host_online = 0` to the directory row, and records `room_closed` (owner or admin) in its audit. The room's `(owner, session)` pair is free again under `rc_rooms_open_session`, and its place under `rc_rooms` is freed.

### 4.7 Error catalogue

| code | status | when |
| --- | --- | --- |
| `unauthorized` | 401 | No bearer; bearer fails JWKS verification. |
| `rate_limited` | 429 | `rc:{sub}` (REST) or `rc:dial:{sub}` (sockets) exceeded 600 in 60 s; header `retry-after: 60`. |
| `bad_request` | 400 | Body not JSON; body fails `CreateRcRoomRequest` or `UpdateRcRoomRequest`; object `/init` body malformed; object `/scope` body without `orgId`. |
| `forbidden` | 403 | `scope.orgId` is not in `claims.orgs` (create or PATCH). The only membership check in the API. |
| `rc_refused` + `gate` | 403 | `platform_flag`: the global layer is off (create, either dial, scope). `org_setting`: the scope Organisation's layer is off (create with scope, PATCH scope, member dial). Also from the object's upgrade when the limits header is unparsable ("remote control is turned off", no `gate`). |
| `rc_not_owner` | 403 | PATCH by a non-owner who may see the room; close by an invited member; object `/settings`, `/scope`, `/close` from a non-owner (non-admin). |
| `not_found` | 404 | No such route; no such room / not yours / uninvited admin on read or PATCH / admin of another Organisation on close; a non-owner on the host door; a non-member on the client door; a member whose room's scope is `NULL`; a kicked or revoked user at the object; `scope.workspaceId` not the Organisation's or not readable ("no such workspace"). |
| `limit_reached` | 409 | Open rooms per account at `rc_rooms`. |
| `rc_closed` | 409 | PATCH on an ended room; either dial on an ended room; object doors on an ended room; object `/init` on an initialised object. |
| `rc_scope_set` | 409 | PATCH `scope` when `org_id` is set, or the lock UPDATE changed no row; object `/scope` with a different scope. |
| `rc_no_scope` | 409 | Registered; never returned in this cut. |
| `unavailable` | 503 | The object could not be reached or refused `/init`; the row could not be read back after insert. |

*Reference implementation:* `apps/ingest/src/rc.ts`, `apps/ingest/src/index.ts`, `apps/ingest/src/errors.ts`, `apps/ingest/src/limits.ts`, `apps/ingest/src/rc-do.ts` (the `/init`, `/view`, `/settings`, `/scope`, `/close` doors).

## 5. Socket doors

`GET /rc/host/ws?room=` (the desktop's host socket) and `GET /rc/ws?room=` (everybody else's). Both are answered by `serveRcSocket(req, env)` **before** the bearer check: a browser cannot set headers on a WebSocket, so the ticket rides the subprotocol.

### 5.1 `authorizeWsUpgradeSubject()` (`packages/do-protocol/src/upgrade.ts`)

A second front door beside the existing org-scoped `authorizeWsUpgrade`, not a relaxation of it: the two walk the same ticket and JWKS path, and the org-scoped one keeps refusing a missing `?org=`.

```ts
/** The account a ticket proved, with no Organisation resolved. */
export interface VerifiedSubject {
  userId: string;
  /** The full verified claim set, for a door that then reads `orgs` itself (an optional filter, an admin check). */
  claims: AtlasClaims;
}

export type WsSubjectAuthResult =
  | { ok: true; subject: VerifiedSubject }
  | { ok: false; response: Response };

export async function authorizeWsUpgradeSubject(
  req: Request,
  env: VerifyEnv,
): Promise<WsSubjectAuthResult> {
  const ticket = ticketFromSubprotocol(req.headers.get("Sec-WebSocket-Protocol"));
  if (!ticket) {
    return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  }
  let claims: AtlasClaims;
  try {
    claims = await verifyAccessToken(ticket, envVerifyConfig(env));
  } catch {
    return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  }
  return { ok: true, subject: { userId: claims.sub, claims } };
}

export function stampSubject(req: Request, subject: VerifiedSubject): Request {
  const headers = new Headers(req.headers);
  headers.set(USER_HEADER, subject.userId);
  headers.delete(ORG_HEADER);
  headers.delete(ROLE_HEADER);
  return new Request(req, { headers });
}
```

- **Ticket extraction** (`ticketFromSubprotocol`, existing): split `Sec-WebSocket-Protocol` on `,`, trim each entry, take the **first** entry that starts with `atlas.ticket.`, and the ticket is the rest of it; an empty rest, or no such entry, or no header, is no ticket. The client offers `atlas.v1, atlas.ticket.<jwt>`.
- No ticket → `401` plain text `unauthorized`. Verification failure (`verifyAccessToken` against `AUTH_JWKS_URL` / `JWT_ISSUER` / `JWT_AUDIENCE`) → `401` plain text `unauthorized`. **No `?org=` is read, required or checked.** `claims.orgs` may be `{}`.
- **`stampSubject`** sets `X-Atlas-User-Id` to the verified `sub` (overwriting anything the client sent) and **deletes** `X-Atlas-Org-Id` and `X-Atlas-Role`: an account-scoped object must never read a tenant a caller asserted.

### 5.2 `serveRcSocket()` — steps in order

1. `Upgrade` header, lower-cased, is not `websocket` → `426` plain text `expected a websocket upgrade`.
2. `authorizeWsUpgradeSubject(req, env)`; not ok → its `401`.
3. `room = url.searchParams.get("room")`; missing or empty → `400` plain text `missing room`.
4. `userId = subject.userId`; `host = url.pathname === "/rc/host/ws"`.
5. Rate limit, key `rc:dial:{userId}`, same `RATE_LIMIT` binding (600 per 60 s), fail-open; exceeded → `429 rate_limited` "too many connections; slow down" with `retry-after: 60` (JSON envelope).
6. `row = roomById(room)`; `null` → `404 not_found` "no such room".
7. `owner = row.owner_user_id === userId`. On the **host door**: `!owner` → `404 not_found` "no such room" (only the owner dials the host socket; anyone else sees no room at all). On the **client door**: `!owner && !isInvited(room, userId)` → `404 not_found` "no such room". A non-owner on a solo room therefore gets `404` from the `rc_members` read before the scope is even looked at.
8. `row.status !== "open"` → `409 rc_closed` "this room has ended".
9. **Gate and limits.** The kill switch refuses new dials, host redials included, and closes nothing already open.
   - `owner`: `platform = platformAccess()`; `gate !== null` → `refused("platform_flag")`; `limits = platform.limits` (the account defaults).
   - member: `row.org_id === null` → `404 not_found` "no such room" (an invite outlives its scope only until the revocation lands; until then a member of a room with no scope is answered as if it did not exist); `org = orgAccess(row.org_id)`; `org.gate !== null || org.limits === null` → `refused(org.gate ?? "org_setting")`; `limits = memberLimits(org.limits)`.
10. **Stamp.** `stamped = stampSubject(req, subject)`; `headers = new Headers(stamped.headers)`; strip the share headers `X-Atlas-Share-Id`, `X-Atlas-Share-Session`, `X-Atlas-Share-Comments`, `X-Atlas-Share-Guest`; strip every RC header `X-Atlas-Rc-Room`, `X-Atlas-Rc-Role`, `X-Atlas-Rc-Limits`, `X-Atlas-Rc-Org-Admin`, `X-Atlas-Rc-Link`, `X-Atlas-Rc-Tier`, `X-Atlas-Rc-Link-Expires`, `X-Atlas-Rc-Token-Key`, `X-Atlas-Rc-Guest`; then set:

| header | value |
| --- | --- |
| `X-Atlas-User-Id` | the verified `sub` (set by `stampSubject`) |
| `X-Atlas-Rc-Room` | `room` |
| `X-Atlas-Rc-Role` | `host` on the host door, `member` on the client door (the object decides `owner` vs `member` from its own `owner_user_id`) |
| `X-Atlas-Rc-Limits` | `JSON.stringify(limits)` — all six keys, e.g. `{"rc_rooms":3,"rc_participants":12,"rc_links":5,"rc_tail_bytes":2097152,"rc_offline_grace_ms":3600000,"rc_command_burst":10}` |

The upgrade **request itself is reused** (`new Request(stamped, { headers })`) so the `101` survives; that is why everything the object trusts is struck and then set, never left as the client sent it.
11. `rcStub(room).fetch(request)`. The object then, in order: the two common checks (`room_id` matches `X-Atlas-Rc-Room`, user non-empty, user not in `revoked_members`) → `404 not_found` "no such room"; the user was kicked within `RC_KICK_MS` → `404 not_found` "no such room"; status not `open` → `409 rc_closed` "this room has ended"; `X-Atlas-Rc-Limits` does not parse to all six numeric keys → `403 rc_refused` "remote control is turned off"; else it builds the socket's attachment (`door` from the role header; `role` is `null` for a host door, `owner` when the user is the owner, else `member`; `tier` is `steer_approve` for the owner, else the room's `member_tier`; the limits as stamped — a socket keeps the limits it connected under whatever Ops changes later), accepts the server end with hibernation, arms the hello deadline (`RC_HELLO_TIMEOUT_MS`), and answers the **`101`** with exactly one header:

```
Sec-WebSocket-Protocol: atlas.v1
```

The ticket entry is **not** echoed (reflecting a credential back onto the wire is how it ends up in a proxy log). A host-door socket is the room's host only once its `rc.hello` presents the secret; a client-door socket is the owner or a member as the object decided.

*Reference implementation:* `apps/ingest/src/rc.ts` (`serveRcSocket`), `packages/do-protocol/src/upgrade.ts`, `packages/do-protocol/src/ws.ts`, `apps/ingest/src/rc-names.ts`, `apps/ingest/src/do-names.ts` (`stripShareHeaders`), `apps/ingest/src/rc-do.ts` (`fetch`, `upgrade`).

## 6. Web proxy (`apps/web/src/lib/rc-proxy.ts`, `server.ts`, `document-headers.ts`)

The browser never talks to `atlas-ingest`. The page calls its own origin under `/api/rc/*`; the web worker checks the Origin, mints an access token server-side off the session cookie, and forwards over the internal `INGEST` service binding. No page script ever holds a credential that could steer somebody's desktop.

### 6.1 Routing in `server.ts`

`RC_PREFIX = '/api/rc'` and `isRcPath(pathname)` (`pathname === RC_PREFIX || pathname.startsWith('/api/rc/')`) live in `apps/web/src/lib/rc-path.ts`, a module with no imports so the browser bundle can share the string. In the worker's `fetch`, after `/api/auth*`, `isAiPath` and `isChatPath` and before `isArtifactsPath`: `if (isRcPath(url.pathname)) return proxyRc(request, env)`. Every HTML document the framework renders leaves through `withDocumentHeaders(url, response)`.

### 6.2 The allow-list (`forwardable(pathname, method)`)

Matched on the path the **browser** asked for, before anything is rewritten; `rest` is the path after `/api/rc` (or `/` when empty).

| `rest` | methods forwarded |
| --- | --- |
| starts with `/public/links/` | any (the anonymous sub-prefix; the door itself is ingest's to answer) |
| `/features`, `/invites`, `/ws` | GET |
| `/rooms` | GET only — **never POST**: only a desktop emits a session to control |
| `/rooms/{id}` where `{id}` is `[A-Za-z0-9]+` | GET, PATCH |
| `/rooms/{id}/close` | POST |
| `/rooms/{id}/audit`, `/rooms/{id}/members` | GET |
| `/rooms/{id}/links` | GET, POST |
| `/rooms/{id}/links/{linkId}` (`[A-Za-z0-9]+`) | DELETE |
| `/rooms/{id}/links/{linkId}/password` | PUT, DELETE |
| `/rooms/{id}/invites` | GET, POST |
| `/rooms/{id}/invites/{userId}` (`[^/]+`) | DELETE |
| everything else, including `/host/ws`, `/api/rc` itself, `/rooms/{id}` by DELETE, `/rooms/not-an-id!` | refused |

Refused → `404` with body `{ "error": { "code": "not_found", "message": "No such remote-control resource." } }`, with no token minted and no request to ingest.

### 6.3 `proxyRc(request, env, now = Date.now())` — steps in order

1. `!forwardable(url.pathname, request.method)` → the `404` above.
2. `upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'`.
3. **Origin check, before any mint.** If `request.method !== 'GET' || upgrade`, then `request.headers.get('origin')` must equal `url.origin` exactly; otherwise (different, or absent) → `403` with body `{ "error": { "code": "invalid_origin", "message": "Origin is not trusted." } }`. `invalid_origin` is not one of ingest's codes because it never reaches ingest. A plain GET passes without an Origin.
4. `anonymous = url.pathname.startsWith('/api/rc/public/')`.
5. **Mint**, unless anonymous: `cookie = request.headers.get('cookie')`; absent → `401 { error: { code: "unauthorized", message: "Not signed in." } }`; `token = await tokenForSession(cookie, url.origin, env, now)` — **no Organisation argument**: the token is the account's and the RC doors never take `?org=` as an authorisation input, so a page passing a stale one must not force a re-mint; `null` → the same `401`. `tokenForSession` caches one token per cookie per isolate and reuses it while `now < expiresAtMs - 60_000` (`REMINT_MARGIN_MS = 60_000`, read from the token's `exp`); otherwise it re-mints by calling `${origin}/api/auth/token` over the `AUTH` binding with the cookie.
6. **Target:** `target = new URL(url)`; `target.pathname = '/rc' + url.pathname.slice('/api/rc'.length)`; the query string is kept. `/api/rc/rooms?org=x` becomes `/rc/rooms?org=x`.
7. **Headers:** `headers = new Headers(request.headers)`, then:
   - anonymous: delete `authorization` unless it starts (case-insensitively) with `rclink `; if upgrade, set `Sec-WebSocket-Protocol` to `atlas.v1` plus the first offered entry that starts with `atlas.rc.` and is longer than the prefix (`"atlas.v1, atlas.rc.<token>"`), or `atlas.v1` alone.
   - signed-in upgrade: set `Sec-WebSocket-Protocol` to exactly `` `atlas.v1, atlas.ticket.${token}` ``, **replacing the page's offer wholesale** — a page that put its own `atlas.ticket.…` in the constructor must not have it forwarded. The page offers only `atlas.v1`.
   - signed-in REST: set `authorization` to `` `Bearer ${token}` `` (overwriting one the page sent).
   - always: delete `cookie`, `X-Atlas-User-Id`, `X-Atlas-Org-Id`, `X-Atlas-Role`, and every header whose lower-cased name starts with `x-atlas-rc-`.
8. `env.INGEST.fetch(new Request(target, { method, headers, body: request.body, duplex: 'half' when there is a body }))` and return its response unchanged (a `101` included).

### 6.4 Document headers for `/rc/*`

`withDocumentHeaders` touches only responses whose `content-type` starts with `text/html`. Every document gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), interest-cohort=()`, and on `https:` `Strict-Transport-Security: max-age=63072000; includeSubDomains`. Pages under `/s/` get `Content-Security-Policy: frame-ancestors *`. Every other page gets `X-Frame-Options: DENY` and a CSP; for `pathname === '/rc' || pathname.startsWith('/rc/')` that CSP is exactly:

```
frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; img-src 'self' data:
```

and for every other non-frameable page it is `frame-ancestors 'none'`. A remote-control page is **never frameable**: it draws text an agent that may be prompt-injected wrote beside buttons that steer it. `img-src 'self' data:` means an image an agent names can never beacon a viewer's address to a third party. There is no `script-src` (the framework's inline hydration script is not accounted for). Every path but `/` and `/login` gets `X-Robots-Tag: noindex, nofollow`.

### 6.5 Web routes

Two routes under the `_app` layout: `/rc` (`routes/_app/rc.index.tsx`, the room list) and `/rc/rooms/{roomId}` (`routes/_app/rc.rooms.$roomId.tsx`, one live room — the deep link the desktop hands out). Both **require a session and no Organisation**. In the `_app` layout, when the signed-in person belongs to zero Organisations, every path renders the "Create your organization" screen **except** `pathname === '/rc' || pathname.startsWith('/rc/')`, which renders inside `SoloShell` — a bare shell (mark, "Remote control" title linking to `/rc`, Sign out; no switcher, rail, presence or inbox) — with the route's outlet and the network-status indicator. `useOrgMaybe()` returns the active Organisation or `null` outside an `OrgProvider`; the RC screens are the one legitimate `null`.

Data: the list is `GET /api/rc/rooms` (query key `['rc', 'rooms']`, staleTime 30 s; no org segment in the key); the features hint is `GET /api/rc/features` or `/api/rc/features?org={activeOrgId}` (key `['rc', 'features', orgId ?? '']`, staleTime 5 min). The list groups rows by `orgId` ("Just you" for `null`, "Shared with {name}" otherwise). The room page reads the room out of the **list** (never `GET /rc/rooms/{id}`, which would wake a sleeping room), dials `/api/rc/ws?room={roomId}` over `new WebSocket(url, ['atlas.v1'])` only when the list does not say the room has ended, and loads the scope Organisation's member directory (`orgFullQueryOptions(room.orgId)`) **only when `room.orgId` is set**; a solo room's only person is its owner, and names fall back to `'Someone'`.

*Reference implementation:* `apps/web/src/lib/rc-proxy.ts`, `apps/web/src/lib/rc-path.ts`, `apps/web/src/server.ts`, `apps/web/src/lib/document-headers.ts`, `apps/web/src/lib/session-token.ts`, `apps/web/src/routes/_app.tsx`, `apps/web/src/components/shell/solo-shell.tsx`, `apps/web/src/lib/queries/rc.ts`, `apps/web/src/lib/rc.ts`.

## 7. Organisation events, scope revocation, session erasure

### 7.1 Events consumed

`atlas-auth` publishes `OrgEvent` (the `ChatOrgEvent` discriminated union) onto the queue `atlas-artifact-events`, which ingest consumes (`max_batch_size: 10`, `max_retries: 5`, dead-letter queue `atlas-artifact-events-dlq`). The four kinds, verbatim shapes: `{ kind: "member.removed", org_id, user_id, at }`, `{ kind: "member.added", org_id, user_id, role, at }`, `{ kind: "member.role_changed", org_id, user_id, role, at }`, `{ kind: "org.deleted", org_id, at }`. The consumer acks per message; a message it cannot parse is acked (it would not parse next time either); a delivery that throws is `retry()`-ed, and after six deliveries lands in the DLQ.

`deliverOrgEvent` hands every event to `tellEveryObject`, which tells every Workspace object, then every Shared Thread (`tellEveryThread`), then every RC room (`tellEveryRcRoom`), each attempted independently; a Workspace failure throws first, then a thread failure, then a room failure. `tellEveryRcRoom` is called for **all four** kinds.

### 7.2 `tellEveryRcRoom(env, event)` — the fan-out as built

```ts
export async function tellEveryRcRoom(env: RcFanoutEnv, event: OrgEvent): Promise<number> {
  const rooms = await openRoomsOf(env, event.org_id);
  if (rooms.length === 0) return 0;

  switch (event.kind) {
    case "org.deleted":
      await env.ROUTING_DB.prepare(
        `DELETE FROM rc_members WHERE room_id IN (SELECT id FROM rc_rooms WHERE org_id = ?1 AND status = 'open')`,
      )
        .bind(event.org_id)
        .run();
      break;
    case "member.removed":
      await env.ROUTING_DB.batch([
        env.ROUTING_DB.prepare(
          `DELETE FROM rc_members WHERE user_id = ?2 AND room_id IN (SELECT id FROM rc_rooms WHERE org_id = ?1 AND status = 'open')`,
        ).bind(event.org_id, event.user_id),
        env.ROUTING_DB.prepare(
          `DELETE FROM rc_members WHERE room_id IN (SELECT id FROM rc_rooms WHERE org_id = ?1 AND owner_user_id = ?2 AND status = 'open')`,
        ).bind(event.org_id, event.user_id),
      ]);
      break;
    case "member.added":
    case "member.role_changed":
      break;
  }

  const outcomes = await Promise.allSettled(rooms.map((id) => rcStubOf(env, id).applyOrgEvent(event)));
  const failed = outcomes.filter((o) => o.status === "rejected").length;
  if (failed > 0) throw new Error(`${failed} of ${rooms.length} rc room objects refused ${event.kind}`);
  return outcomes.reduce((n, o) => n + (o.status === "fulfilled" ? o.value : 0), 0);
}
```

In order:

1. `openRoomsOf`: `SELECT id FROM rc_rooms WHERE org_id = ?1 AND status = 'open'` (index `rc_rooms_by_org`). None → return `0`.
2. **D1 first, members only.** `org.deleted`: delete every `rc_members` row of every open room scoped to the Organisation. `member.removed`: delete the removed user's rows in the Organisation's open rooms, **and** every member row of the open rooms that user *owns* in the Organisation (those rooms are about to continue solo). `member.added` and `member.role_changed`: nothing. The `rc_members` rows go first because they are what the dial door reads: a member whose row is gone is `404` at the door before their object has heard.
3. **`rc_rooms.org_id` is NOT cleared here.** It is how a room is found (step 1); clearing it before an object had heard would leave a redelivery with nothing to redeliver to, and the one object that refused would keep its members steering. Each object clears its own row's pair as it revokes (step 5).
4. **The objects, in parallel and independently:** `applyOrgEvent(event)` (an RPC on the stub) on every room from step 1, via `Promise.allSettled`.
5. **Throw after all.** Any rejection → throw `"{failed} of {n} rc room objects refused {kind}"` after every one has been attempted, so the queue redelivers the message. The redelivery still finds the room because its `org_id` still names the Organisation; the objects that already revoked answer `0` (their `org_id` is `NULL`, so the event no longer matches them); a third delivery finds nothing to do and records no second `scope_revoked`.
6. Return the sum of sockets closed.

### 7.3 `applyOrgEvent` and `revokeScope` in the object

`applyOrgEvent(event)` returns `0` at once unless the room is `open`, has a scope, and `room.org_id === event.org_id`. Then:

| kind | what the object does |
| --- | --- |
| `org.deleted` | `revokeScopeAndTell("org_deleted")`. |
| `member.removed`, `user_id` is the owner | `revokeScopeAndTell("owner_removed")`. |
| `member.removed`, anyone else | Close every client socket of that principal `1008` ("removed from the organisation"), cancel their pending control requests with reason `access_revoked`, return the seat to the owner if they were driving (epoch advances), write a tombstone `INSERT INTO revoked_members(user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO NOTHING` so a ticket minted before the removal cannot come back (`404` at the object on every door), record `member_revoked` with `{ sockets, reason: "member_removed" }`, return the count. |
| `member.added` | `DELETE FROM revoked_members WHERE user_id = ?1` (the tombstone is lifted so they may be invited again); return `0`. |
| `member.role_changed` | return `0`. |

`revokeScope(reason)`, sends before storage:

1. For every client socket with `role === "member"`: close `1008` with reason text `the room is no longer shared`, forget it, count it. Owner sockets (any surface) and the host are untouched.
2. If the driver is not the owner, return the seat to the owner (epoch advances).
3. Cancel every pending control request with reason `access_revoked`.
4. `UPDATE room_state SET revoked_org_id = org_id, org_id = NULL, workspace_id = NULL WHERE id = 1`; `DELETE FROM revoked_members`.
5. Record `scope_revoked` with actor `system` and detail `{ reason, sockets }`; mark the roster dirty (owner surfaces get a fresh `rc.roster`); mark the directory dirty.

`revokeScopeAndTell` then flushes the directory **now** rather than on the alarm — the row is what the dial door reads — and re-arms the alarm. `flushDirectory` runs one D1 batch: the status/`host_online` mirror `UPDATE rc_rooms SET status = ?1, ended_at = ?2, end_reason = ?3, purge_at = ?4, host_online = ?5 WHERE id = ?6 AND (status = 'open' OR ?1 = 'ended')`, and, because `revoked_org_id` is set, `UPDATE rc_rooms SET org_id = NULL, workspace_id = NULL WHERE id = ?1 AND org_id = ?2` bound to `(room_id, revoked_org_id)` — over the revoked scope only, never over one the owner has set since. On success `revoked_org_id` is cleared; on failure the write is retried on the alarm with exponential backoff from 30 s capped at 30 min. The room continues solo: the host keeps streaming, the owner keeps steering from every surface, and a revoked scope may be set again by `PATCH { scope }` (set-once binds the owner's changes, not a revocation).

**What a member experiences:** their socket closes `1008` and the client stops reconnecting; a redial is `404` at the door (no `rc_members` row, or a solo room) and, for a removed member, `404` at the object for as long as the tombstone stands; the owner's surfaces see a roster without them, a driver epoch one higher if they were driving, and nothing else changes.

### 7.4 Session erasure (`erase.ts` → `endErasedRcRooms`)

When the Organisation's owner erases recorded Sessions, `forget(env, orgId, workspaceId, erased)` in `erase.ts` runs, after the tombstone/handle/notification deletes, the share revocations and the vector-deletion queue sends, and **before** `settleErasures`:

```ts
await endErasedRcRooms(env, orgId, workspaceId, ids, erased[0]!.deletedBy);
```

where `ids` is every erased `sessionId` and `deletedBy` is the erasing account. `endErasedRcRooms(env, orgId, workspaceId, sessionIds, erasedBy)`:

1. No ids → return `0`.
2. `SELECT id FROM rc_rooms WHERE org_id = ?1 AND workspace_id = ?2 AND status = 'open' AND session_id IN (?3, ?4, …)` — only rooms scoped to that Workspace, because erasure is per Workspace Session; a room already ended is not selected. None → return `0`.
3. For each, in parallel (`Promise.allSettled`): `POST https://rc/close` on `rc:{id}` with headers `content-type: application/json`, `X-Atlas-User-Id: {erasedBy}`, `X-Atlas-Rc-Room: {id}`, `X-Atlas-Rc-Org-Admin: 1`, body `{"reason":"erased"}`. The admin header is what lets the object take a close from somebody who does not own the room (the Organisation's owner outranks its admins). A non-`ok` answer throws `"rc room {id} answered {status} to the erasure"`.
4. Throw after all: any failure → `"{failed} of {n} rc room objects refused the erasure"`, so the erase door's retry (a pending tombstone comes back through `forget`) finishes it; every step is idempotent.
5. Return the count.

The object ends the room `erased`: every socket gets `rc.closed { reason: "erased" }` and `4410`, the tail, snapshot and commands are deleted at once, and `purge_at` is set to **now** rather than `now + 7 days`, so the directory rows and the object's storage (audit included) go on its next alarm — the Session must not survive as a tail, a snapshot and a week of prompt excerpts.

*Reference implementation:* `apps/ingest/src/rc-revoke.ts`, `apps/ingest/src/org-events.ts`, `apps/ingest/src/erase.ts`, `apps/ingest/src/rc-do.ts` (`applyOrgEvent`, `revokeScope`, `flushDirectory`, `end`), `apps/ingest/wrangler.jsonc` (queue consumer).

## 8. The room object (`RcRoomDurableObject`)

One Durable Object instance per room, SQLite-backed, in `atlas-ingest`. It holds
the one **host socket** (the owner's desktop) and every **client socket** (the
owner on another surface, an invited member), relays the host's binary stream
frames to clients before it stores anything, keeps a byte-bounded tail and the
host's latest snapshot for late joiners, relays steering commands to the host
and the host's answers back, and owns the driver seat. It reads a binary
frame's header and never its payload. It touches D1 only to keep its own
`rc_rooms` directory row current (`status`, `host_online`, the revoked scope,
and the deletion at purge) and never on a live path.

Five rules every handler in this section obeys:

1. **Relay first, then storage.** A SQLite-backed object holds outgoing
   messages until prior writes flush (output gating). In every handler that
   both sends and writes, every send comes before the first write.
2. **No storage write per frame.** The tail is an in-memory ring, checkpointed
   to SQLite 1 000 ms after the stream goes quiet and at least every 30 000 ms
   while it never pauses.
3. **No D1 on any live path.** Who a socket is and what it may do is decided
   at the door and stamped on the upgrade request; every later frame is
   decided from that stamp and the object's own state.
4. **Bounded bytes in flight.** Clients `rc.ack`; a viewer more than 2 MiB
   behind for 10 s is cut `1013`; joins and snapshot waves are admitted only
   under a 16 MiB per-room budget on a 100 ms tick.
5. **Nothing is queued for an absent owner.** A command while the desktop is
   offline is refused at once; one already relayed when the desktop left is
   `relay_timeout` after 30 s.

The constants the object uses, all from `@atlas/contracts` unless marked
*object-local*. Every byte figure is bytes; every time figure is milliseconds.

| constant | value | governs |
| --- | --- | --- |
| `RC_PROTOCOL_VERSION` | 1 | the `protocol` field of every hello and welcome |
| `RC_SOCKETS_MAX` | 64 | client sockets per room, counted from connect |
| `RC_SOCKETS_PER_PRINCIPAL` | 4 | helloed client sockets per principal |
| `RC_ROOM_INFLIGHT_BYTES` | 16 777 216 | un-acked bytes across a room before joins wait |
| `RC_VIEWER_LAG_BYTES` | 2 097 152 | un-acked bytes on one socket that mark it lagging |
| `RC_VIEWER_LAG_MS` | 10 000 | how long a socket may lag before it is cut `1013` |
| `RC_DELTA_MAX_BYTES` | 262 144 | largest binary frame, header included |
| `RC_FRAME_HEADER_MAX_BYTES` | 19 | longest binary header (3 bytes + two 8-byte varints) |
| `RC_SNAPSHOT_PART_MAX_BYTES` | 262 125 | payload bytes per snapshot part the object sends |
| `RC_SNAPSHOT_MAX_BYTES` | 1 048 576 | largest reassembled snapshot |
| `RC_REHELLO_MAX` | 3 | re-hellos per `RC_REHELLO_WINDOW_MS` after `rc.resync { reason: "ahead" }` |
| `RC_REHELLO_WINDOW_MS` | 60 000 | the re-hello window |
| `RC_HOST_PING_MS` | 15 000 | the host's ping interval (host side) |
| `RC_HOST_SILENT_MS` | 45 000 | a host silent this long is offline |
| `RC_HOST_SWEEP_MS` | 15 000 | the alarm period while a host is connected |
| `RC_CLIENT_PING_MS` | 25 000 | a client's ping interval (client side) |
| `RC_CLIENT_SILENT_MS` | 120 000 | a client silent this long is closed `1001` |
| `RC_HELLO_TIMEOUT_MS` | 10 000 | a socket on either door closed `1001` without a hello |
| `RC_CHECKPOINT_DEBOUNCE_MS` | 1 000 | quiet period before the ring is checkpointed |
| `RC_CHECKPOINT_MAX_MS` | 30 000 | longest the ring stays unsaved under a continuous stream |
| `RC_COMMAND_TIMEOUT_MS` | 30 000 | a relayed command unanswered this long is `relay_timeout` |
| `RC_COMMAND_PER_SECOND` | 2 | refill rate of a principal's command bucket |
| `RC_COMMANDS_KEPT` | 500 | non-pending command rows kept per room |
| `RC_PROMPT_MAX` | 32 768 | largest `submit.content`, UTF-8 bytes |
| `RC_COMMAND_FRAME_MAX_BYTES` | 36 864 | largest text frame of any kind, UTF-8 bytes |
| `RC_COMMAND_VALUE_MAX_BYTES` | 8 192 | largest `answer_elicitation.answer` / `set_config_option.value`, serialised |
| `RC_CONTROL_MAX_BYTES` | 4 096 | largest text frame whose `t` is not `rc.command`, UTF-8 bytes |
| `RC_ACK_MAX_PER_SECOND` | 10 | acks counted per socket per second; the rest ignored |
| `RC_HOST_FIRST_HELLO_MS` | 60 000 | a room with no host hello this long after creation ends `never_hosted` |
| `RC_SNAPSHOT_REQUEST_TIMEOUT_MS` | 10 000 | one snapshot request in flight; parked joiners answered after this |
| `RC_SNAPSHOT_MIN_INTERVAL_MS` | 5 000 | an unrequested snapshot inside this window of the last is dropped |
| `RC_ROSTER_TICK_MS` | 100 | the roster / join tick |
| `RC_CONTROL_REQUEST_TIMEOUT_MS` | 60 000 | a control request's life |
| `RC_CONTROL_COOLDOWN_MS` | 30 000 | wait after a decline or a time-out before asking again |
| `RC_DRIVER_GRACE_MS` | 30 000 | the seat waits this long for a driver whose last socket closed |
| `RC_KICK_MS` | 600 000 | a kicked principal's dials are refused this long |
| `RC_ROOM_RETENTION_MS` | 604 800 000 | an ended room's audit is kept this long (7 days) |
| `RC_MEMBERS_ONLY_COMMANDS` | `["set_config_option"]` | command kinds a non-`user` principal may never send |
| `CHECKPOINT_ROW_BYTES` *(object-local)* | 1 572 864 | largest `tail_checkpoint.bytes` row (1.5 MiB) |
| `D1_RETRY_MS` *(object-local)* | 30 000 | first retry of a failed directory write; doubles |
| `D1_RETRY_CAP_MS` *(object-local)* | 1 800 000 | the retry cap (30 min) |
| `STATS_WINDOW_MS` *(object-local)* | 10 000 | one `rc_room_stats` log line per window while frames flow |
| `EXCERPT_MAX` *(object-local)* | 140 | code points of a prompt the audit keeps |
| `SYSTEM_ACTOR` *(object-local)* | `"system"` | the audit's actor id and kind when the object itself acted |

The per-account limits (the `rc.enabled` catalogue defaults; the only values a
solo room ever sees) are:

| limit key | default | min | max | unit |
| --- | --- | --- | --- | --- |
| `rc_rooms` | 3 | 1 | 50 | count |
| `rc_participants` | 12 | 1 | 100 | count |
| `rc_links` | 5 | 1 | 50 | count |
| `rc_tail_bytes` | 2 097 152 | 262 144 | 8 388 608 | bytes |
| `rc_offline_grace_ms` | 3 600 000 | 30 000 | 14 400 000 | count (milliseconds) |
| `rc_command_burst` | 10 | 1 | 100 | count |

### 8.1 Naming and placement

The instance for a room is named from the room id alone:

```ts
export function rcDoName(roomId: string): string {
  return `rc:${roomId}`;
}
```

The name carries no Organisation, because a room belongs to an account and its
scope is nullable and set once. Every door and the fan-out resolve the stub with
`env.RC_DO.get(env.RC_DO.idFromName(rcDoName(roomId)))`.

**Placement.** An object is placed near the colo of the first `get()` on its
name and never moves. The create door (`POST /rc/rooms`) is the first and only
caller allowed to address a fresh name: it mints the room id (a ULID), calls the
object's `POST /init`, and only then writes the `rc_rooms` row. Every other door
reads the `rc_rooms` row first, and the row exists only once the object does.

**The contrivance guard.** Every request into the object other than `/init`
must carry the room header equal to the stored `room_id` and a non-empty user
id. The object checks, in this order, and answers `404 not_found "no such room"`
when any fails:

1. `room_state.room_id` is not `NULL` (the object has been initialised);
2. the `X-Atlas-Rc-Room` header equals `room_id`;
3. the `X-Atlas-User-Id` header is non-empty;
4. the user is not in `revoked_members`.

The header names, defined in one module with no imports so the object and the
doors both read it:

```ts
export const RC_ROOM_HEADER = "X-Atlas-Rc-Room";
export const RC_ROLE_HEADER = "X-Atlas-Rc-Role";
export const RC_LIMITS_HEADER = "X-Atlas-Rc-Limits";
export const RC_ORG_ADMIN_HEADER = "X-Atlas-Rc-Org-Admin";
export const RC_LINK_HEADER = "X-Atlas-Rc-Link";
export const RC_TIER_HEADER = "X-Atlas-Rc-Tier";
export const RC_LINK_EXPIRES_HEADER = "X-Atlas-Rc-Link-Expires";
export const RC_TOKEN_KEY_HEADER = "X-Atlas-Rc-Token-Key";
export const RC_GUEST_HEADER = "X-Atlas-Rc-Guest";
```

| header | set by | meaning |
| --- | --- | --- |
| `X-Atlas-Rc-Room` | every door and the fan-out | which room the request is about; must equal the stored `room_id` |
| `X-Atlas-Rc-Role` | the socket doors | `host` for `/rc/host/ws`, `member` for `/rc/ws`; anything else reads as `member` |
| `X-Atlas-Rc-Limits` | the socket doors | the effective `RcLimits` as JSON (§8.12) |
| `X-Atlas-Rc-Org-Admin` | the close door and the erase fan-out | `"1"` when the caller is an admin of the scope Organisation (or the eraser); REST only |
| `X-Atlas-Rc-Link`, `X-Atlas-Rc-Tier`, `X-Atlas-Rc-Link-Expires`, `X-Atlas-Rc-Token-Key`, `X-Atlas-Rc-Guest` | nobody yet | reserved for the public-link door; declared so every door strips them today |

`X-Atlas-User-Id` is `USER_HEADER` from `@atlas/do-protocol`. The socket doors
forward the client's own upgrade request so the `101` survives, which means the
client's headers travel with it. Every door therefore strikes every name above
(`stripRcHeaders(headers)` deletes all nine) plus the share headers, and then
sets the ones it trusts. Nothing the object reads is ever left as the client
sent it.

*Reference implementation:* `apps/ingest/src/rc-names.ts`.

### 8.2 State

**SQLite.** The schema is versioned; `migrate()` runs in the constructor inside
`blockConcurrencyWhile`, and again after a purge. Its rule: if the `room_state`
table does not exist the version is 0, else it is `room_state.schema_version`;
every migration from that version to the end of the list runs in order, and
`schema_version` is then set to the list's length. A migration is a function of
`SqlStorage`; the list is append-only.

Migration **v1** creates every table:

```sql
CREATE TABLE room_state(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL DEFAULT 0,
  org_id TEXT,
  workspace_id TEXT,
  room_id TEXT,
  owner_user_id TEXT,
  owner_client_id TEXT,
  host_secret_hash TEXT,
  member_tier TEXT NOT NULL DEFAULT 'view',
  accept_requests INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '[]',
  agent TEXT,
  model TEXT,
  status TEXT,
  driver_id TEXT,
  driver_kind TEXT,
  driver_name TEXT,
  driver_client_id TEXT,
  driver_epoch INTEGER NOT NULL DEFAULT 1,
  driver_lost_at INTEGER,
  head INTEGER NOT NULL DEFAULT 0,
  tail_floor INTEGER NOT NULL DEFAULT 1,
  tail_bytes INTEGER NOT NULL DEFAULT 0,
  gap_after INTEGER,
  snapshot_owed INTEGER NOT NULL DEFAULT 0,
  resync_hold INTEGER NOT NULL DEFAULT 0,
  snapshot_requested_at INTEGER,
  last_checkpoint_at INTEGER,
  tail_limit INTEGER NOT NULL DEFAULT 2097152,
  host_first_hello_by INTEGER,
  owner_offline_at INTEGER,
  offline_grace_ms INTEGER NOT NULL DEFAULT 600000,
  created_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  purge_at INTEGER,
  d1_pending INTEGER NOT NULL DEFAULT 0,
  d1_retry_at INTEGER,
  d1_attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO room_state(id) VALUES (1);

CREATE TABLE tail_checkpoint(
  chunk INTEGER PRIMARY KEY,
  seq_first INTEGER NOT NULL,
  seq_last INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE snapshot(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  as_of_seq INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE rc_control_requests(
  request_id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  from_name TEXT,
  from_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  answered_by TEXT,
  reason TEXT
);
CREATE INDEX rc_control_pending ON rc_control_requests(status, expires_at);

CREATE TABLE rc_commands(
  from_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY (from_id, command_id)
);
CREATE INDEX rc_commands_by_status ON rc_commands(status, at);

CREATE TABLE revoked_members(user_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE revoked_links(link_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE kicked(principal_id TEXT PRIMARY KEY, until INTEGER NOT NULL);

CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  subject_id TEXT,
  request_id TEXT,
  command_id TEXT,
  driver_epoch INTEGER,
  detail TEXT NOT NULL
);
```

Migration **v2** adds one column:

```sql
ALTER TABLE room_state ADD COLUMN revoked_org_id TEXT;
```

After both, `schema_version` is `2`.

The `room_state` row (always `id = 1`), column by column:

| column | type | meaning |
| --- | --- | --- |
| `schema_version` | INTEGER | the migrations applied; `2` today |
| `org_id`, `workspace_id` | TEXT nullable | the scope; both `NULL` for a solo room; set once by `/init` or `/scope`; revoked back to `NULL`. Never read on a live path |
| `room_id` | TEXT nullable | the room id the object was initialised with; `NULL` means uninitialised (or purged) |
| `owner_user_id` | TEXT | the account that owns the room; owner-versus-member is decided against this |
| `owner_client_id` | TEXT | the desktop replica id that may host |
| `host_secret_hash` | TEXT | lowercase hex SHA-256 of the host secret; the secret itself is stored nowhere |
| `member_tier` | TEXT | `view` / `steer` / `steer_approve`; what an invited member's socket is badged with |
| `accept_requests` | INTEGER | `1` while the room takes `rc.request_control`; `0` after `PATCH { acceptRequests: false }` |
| `capabilities` | TEXT | JSON array of the capabilities the desktop advertised at creation |
| `agent`, `model` | TEXT | informational, from `/init` |
| `status` | TEXT | `open` or `ended`; `NULL` before `/init` |
| `driver_id`, `driver_kind`, `driver_name` | TEXT | the seat's principal; starts as the owner (`kind = 'user'`, `name = NULL`) |
| `driver_client_id` | TEXT | created by v1, never written or read |
| `driver_epoch` | INTEGER | starts at `1`; `+1` on every seat change |
| `driver_lost_at` | INTEGER nullable | when a non-owner driver's last socket closed; the grace counts from here |
| `head` | INTEGER | newest seq the room holds, as of the last checkpoint |
| `tail_floor` | INTEGER | oldest seq the ring still holds, as of the last checkpoint |
| `tail_bytes` | INTEGER | ring bytes, as of the last checkpoint |
| `gap_after` | INTEGER nullable | the last contiguous seq before a known gap |
| `snapshot_owed` | INTEGER | `1` while a snapshot is wanted (gap, resync, eviction) |
| `resync_hold` | INTEGER | `1` after a host `rc.resync` until its snapshot arrives; deltas refused meanwhile |
| `snapshot_requested_at` | INTEGER nullable | when the current `rc.snapshot_request` was sent |
| `last_checkpoint_at` | INTEGER nullable | when the ring was last written |
| `tail_limit` | INTEGER | the `rc_tail_bytes` limit the room was created under |
| `host_first_hello_by` | INTEGER nullable | `created_at + 60 000` until the first host hello, then `NULL` |
| `owner_offline_at` | INTEGER nullable | when the host socket last went; `NULL` while a host is connected |
| `offline_grace_ms` | INTEGER | the `rc_offline_grace_ms` limit the room was created under |
| `created_at`, `ended_at` | INTEGER | timestamps |
| `end_reason` | TEXT nullable | one of `RC_END_REASONS` once ended |
| `purge_at` | INTEGER nullable | when the object purges itself; `ended_at + RC_ROOM_RETENTION_MS`, or `ended_at` for `erased` |
| `d1_pending` | INTEGER | `1` while the directory row is behind the object |
| `d1_retry_at` | INTEGER nullable | when the next directory write is due |
| `d1_attempts` | INTEGER | failed directory writes so far (drives the backoff) |
| `revoked_org_id` | TEXT nullable | the scope just revoked, until the directory row has been cleared of it |

The other tables:

| table | row | meaning |
| --- | --- | --- |
| `tail_checkpoint` | `chunk` (0-based), `seq_first`, `seq_last`, `bytes`, `at` | the ring at the last checkpoint: whole frames, header included, each prefixed by its byte length as a varint, concatenated in ring order; at most 1 572 864 bytes a row |
| `snapshot` | `id = 1`, `as_of_seq`, `parts`, `bytes`, `at` | the host's latest snapshot, reassembled; read on demand, never held in memory |
| `rc_control_requests` | `request_id` (ULID), `from_id`, `from_name`, `from_kind`, `status`, `requested_at`, `expires_at`, `answered_at`, `answered_by`, `reason` | every request for the seat; `status` is `pending` / `approved` / `declined` / `timed_out`; `answered_by` is a principal id or `system`; `reason` is `NULL`, `access_revoked`, `left`, `kicked` or `room_closed` |
| `rc_commands` | `(from_id, command_id)`, `kind`, `at`, `status`, `result` | relayed commands for idempotency; `status` is `pending` / `done` / `refused` / `timed_out`; `result` is the JSON of the `rc.command_result` frame sent, or `NULL` while pending |
| `revoked_members` | `user_id`, `at` | members removed from the scope Organisation; `404` at every door of this object |
| `revoked_links` | `link_id`, `at` | created by v1; unused until public links |
| `kicked` | `principal_id`, `until` | kicked principals; the dial is refused while `until > now` |
| `audit` | §8.11 | the room's audit log |

**In memory.** Rebuilt on every wake from storage and `getWebSockets()`; a woken
room has, by definition, drained its buffers.

| field | type | rebuilt from |
| --- | --- | --- |
| `room` | `StateRow` | `SELECT * FROM room_state WHERE id = 1` |
| `sockets` | `Map<WebSocket, RcSocketState>` | every socket from `getWebSockets()` whose attachment is not `null` |
| `hostWs` | `WebSocket \| null` | the attached socket with `host: true` and the newest `helloAt` |
| `ring` | `Array<{ seqFirst, seqLast, bytes }>` | `tail_checkpoint` rows in `chunk` order, split on the length varints; a frame whose header does not decode is skipped |
| `ringBytes` | number | the sum of ring frame lengths |
| `head`, `tailFloor`, `gapAfter`, `snapshotOwed`, `resyncHold`, `snapshotRequestedAt` | as the columns | the `room_state` columns |
| `snapshotAsOf` | `number \| null` | `snapshot.as_of_seq` or `null` |
| `lastSnapshotAt`, `bytesSinceSnapshot` | number | `0` |
| `hostOwesSnapshot` | boolean | `false`; set `true` when a host welcome says `wants: "snapshot"` |
| `assembling` | `{ asOf, parts, bytes } \| null` | `null`; the snapshot being reassembled from parts |
| `ringDirty`, `dirtySince`, `lastHostFrameAt` | boolean, number, number | `false`, `0`, `0` |
| `checkpointTimer`, `checkpointSettle` | timer, resolver | `null`; the debounce and its `waitUntil` promise |
| `joinQueue` | `Array<WebSocket>` | every attached, helloed, non-host socket with `ready: false` (its catch-up was interrupted), in `getWebSockets()` order; the tick is scheduled if non-empty |
| `tickTimer`, `rosterDirty` | timer, boolean | `null`, `false` |
| `buckets` | `Map<principalId, RateBucket>` | empty; one command bucket per principal |
| `stats`, `wakeMs` | counters | fresh; the wake duration |

Per-socket live state (`RcSocketState`) is the attachment plus accounting:

| field | type | meaning |
| --- | --- | --- |
| `phase` | `"new" \| "queued" \| "parked" \| "resync" \| "ready" \| "unhelloed"` | `new` before hello; `queued` waiting for a catch-up; `parked` waiting for the host's snapshot; `resync` after a host resync; `ready` receiving live frames; `unhelloed` told to start over (`reason: "ahead"`) |
| `sentSeq`, `ackedSeq` | number | newest seq sent to it; newest it acked |
| `inflight` | `Array<{ seq, bytes }>` | frames sent since its last ack, in order |
| `unackedBytes` | number | sum of `inflight` bytes |
| `lagSince` | `number \| null` | when `unackedBytes` first exceeded `RC_VIEWER_LAG_BYTES` |
| `lastHeardAt` | number | last text or binary frame from it |
| `ackWindow` | `{ at, n }` | the per-second ack counter |
| `rehellos` | `Array<number>` | re-hello timestamps in the window |
| `joinAt` | number | when it said hello this time (for the time-to-first-paint log) |
| `opBucket` | `RateBucket \| null` | the 5-burst / 1-per-second bucket for master and arbitration frames |

On rebuild from an attachment: `phase` is `ready` when `host` or `ready`, `new`
when `clientId` is `null`, else `queued`; `sentSeq = ackedSeq = since`;
everything else is empty or `now`.

`RateBucket(burst, perSecond)` starts full; `take(now)` refills
`(elapsed / 1000) × perSecond` up to `burst`, then takes one token or answers
`false`. It lives in memory only: the object hibernates only after a quiet
period, which is when it would have refilled anyway.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`MIGRATIONS`, `StateRow`,
`RcSocketState`, `load()`).

### 8.3 Internal HTTP router (`fetch`)

Only this worker reaches the object: the doors in `apps/ingest/src/rc.ts`, the
fan-out in `rc-revoke.ts`, and the erase door. There is no public route to it.

`POST /init` is matched **before** the contrivance guard (the room has no id
yet). Its body is parsed with a strict Zod schema; a body that fails parses
answers `400 bad_request "malformed room init"`. Never cast.

```ts
export const RcInit = z
  .object({
    orgId: z.string().min(1).nullable(),
    workspaceId: z.string().min(1).nullable(),
    roomId: z.string().min(1).max(64),
    ownerUserId: z.string().min(1),
    ownerClientId: RcClientId,
    hostSecretHash: z.string().regex(/^[0-9a-f]{64}$/),
    memberTier: RcTier,
    capabilities: z.array(RcCapability).max(8),
    agent: z.string().min(1),
    model: z.string().nullable(),
    limits: RcLimits,
    at: z.number().int().nonnegative(),
  })
  .strict();
```

`RcClientId` is `/^[A-Za-z0-9_-]{8,64}$/`; `RcLimits` is a strict object of the
six limit keys, each `z.number().int().nonnegative()`.

`/init` then:

1. if `room_id` is already set → `409 rc_closed "room already exists"`;
2. one `UPDATE room_state` setting `org_id`, `workspace_id`, `room_id`,
   `owner_user_id`, `owner_client_id`, `host_secret_hash`, `member_tier`,
   `capabilities` (JSON), `agent`, `model`, `status = 'open'`,
   `driver_id = ownerUserId`, `driver_kind = 'user'`, `driver_epoch = 1`,
   `tail_limit = limits.rc_tail_bytes`,
   `offline_grace_ms = limits.rc_offline_grace_ms`,
   `host_first_hello_by = at + 60000`, `created_at = at`;
3. audit `room_created` (actor the owner; detail `{ agent, memberTier, orgId,
   workspaceId }`);
4. `rearm()`;
5. `201 { "driverEpoch": 1 }`.

Every other request passes the contrivance guard of §8.1, then:

| route | guard beyond §8.1 | body | response |
| --- | --- | --- | --- |
| any method with `Upgrade: websocket` | the user is not in `kicked` with `until > now`, else `404 not_found "no such room"` | — | §8.4 |
| `GET /view` | none | — | `200 { status, hostOnline, driverEpoch, driver, sockets }` |
| `POST /settings` | room open (`409 rc_closed "this room has ended"`); user is the owner (`403 rc_not_owner "only the room owner may change it"`) | `{ memberTier?, acceptRequests?, title? }`, cast | `200 { memberTier, acceptRequests }` |
| `POST /scope` | room open (`409 rc_closed`); owner (`403 rc_not_owner`); `orgId` a non-empty string (`400 bad_request "name the scope's orgId"`) | `{ orgId, workspaceId }`, cast | §8.9 |
| `POST /close` | user is the owner **or** `X-Atlas-Rc-Org-Admin: 1` (`403 rc_not_owner "only the room owner or an admin may close it"`) | `{ reason? }`, `RcEndReason`, passthrough | `204` |
| any other method and path | — | — | `404 not_found "no such route"` |
| `applyOrgEvent(event)` | an RPC method, not a route (§8.9) | `OrgEvent` | the number of sockets cut |

`GET /view` answers the live facts D1 does not hold:

```ts
interface RcRoomView {
  status: "open" | "ended";
  hostOnline: boolean;      // hostWs !== null
  driverEpoch: number;
  driver: RcPrincipalRef;   // { id, kind, name }
  sockets: number;          // client sockets, hello or not
}
```

`POST /settings` (`RcSettingsChange`): when `memberTier` is present and differs
from the stored tier, every socket with `role === "member"` is re-badged in place
(`tier` updated and the attachment re-serialised); if the new tier does not
allow `submit` (that is, it is `view`) and the driver is a `user` other than the
owner, the seat returns to the owner; the roster is marked dirty. Then the
writes: `member_tier` when given, `accept_requests` as `1`/`0` when given. Then
audit `settings_changed` with detail `{ memberTier: tier ?? null, acceptRequests:
change.acceptRequests ?? null, title: title === undefined ? null : "changed" }`.
The title itself lives in D1 and is never stored here.

`POST /close`: the reason written is `erased` when the body says `erased`;
otherwise `closed_by_owner` when the user is the owner, else `closed_by_admin`
— whatever the body asked. The audit detail gains `admin: true` when the admin
header was set. The room ends per §8.4; the response is `204` with no body, and
`204` again when the room had already ended (`end()` is idempotent).

Body parsing for `/settings`, `/scope` and `/close` tolerates a non-JSON body
(`readJson` answers `null`); `/close` with an unparseable body is treated as the
owner closing it.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`fetch`, `init`,
`settings`, `view`).

### 8.4 Socket lifecycle

**Upgrade.** A request with `Upgrade: websocket` that passed the guards of §8.1
and §8.3 is handled by `upgrade(req, userId)`:

1. room not open → `409 rc_closed "this room has ended"`;
2. `X-Atlas-Rc-Limits` absent or malformed (§8.12) → `403 rc_refused "remote
   control is turned off"`;
3. `door` is `host` when `X-Atlas-Rc-Role` is exactly `host`, else `member`;
4. `owner` is `userId === owner_user_id`;
5. the attachment is built and serialised onto the server socket, the socket is
   accepted with `ctx.acceptWebSocket(server)` (the hibernation API), the live
   state is put in the map, `rearm()` is scheduled under `waitUntil`, and the
   `101` is returned with the client half (`acceptedUpgrade(client)` from
   `@atlas/do-protocol`, which echoes only the `atlas.v1` subprotocol).

The attachment, kept well under the 2 KiB attachment cap:

```ts
interface RcAttachment {
  door: "host" | "member";
  host: boolean;                 // false until the host hello passes
  role: "owner" | "member" | "link" | null;   // null on the host door
  principal: { id: string; kind: "user" | "guest" | "link"; name: string | null };
  tier: "view" | "steer" | "steer_approve";
  clientId: string | null;       // set by hello
  surface: "web" | "mobile" | "desktop" | null;
  since: number;                 // the hello's since
  ready: boolean;                // the catch-up has been sent
  connectedAt: number;
  helloAt: number | null;
  limits: RcLimits;
}
```

At upgrade: `host: false`; `role` is `null` on the host door, `"owner"` when the
user is the owner, else `"member"`; `principal` is `{ id: userId, kind: "user",
name: null }`; `tier` is `steer_approve` for the owner, else the room's
`member_tier`; `clientId`, `surface`, `helloAt` are `null`; `since` is `0`;
`ready` is `false`; `connectedAt` is now.

A socket on **either** door counts toward `RC_SOCKETS_MAX` from the moment it
connects and must say hello within `RC_HELLO_TIMEOUT_MS` (10 000 ms) or the
alarm closes it `1001 "no hello"`, however often it pings.

**Keepalive.** The constructor registers
`setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))`: a
text frame `ping` is answered `pong` by the runtime without waking the object.
Hosts ping every 15 000 ms, clients every 25 000 ms. "Last heard" for a socket is
the maximum of its auto-response timestamp, its last frame (for the host, the
later of its last binary frame and its last text frame), its `helloAt` and its
`connectedAt`.

**Text frame handling (`webSocketMessage`)**, in order, for any socket:

1. the socket's state is found in the map, or rebuilt from its attachment; an
   attachment of `null` (a forgotten socket) means the frame is ignored;
2. `lastHeardAt = now`;
3. a binary message goes to the stream path (§8.5);
4. UTF-8 size `> 36 864` → `rc.refused { code: "payload_too_large", message:
   "that frame is too large" }`;
5. not JSON → `rc.refused { code: "bad_frame", message: "not JSON" }`;
6. `t !== "rc.command"` and size `> 4 096` → `rc.refused { ref?, code:
   "payload_too_large", message: "a control frame is at most 4096 bytes" }`;
7. does not parse as `RcInboundControl` → `rc.refused { ref?, code: "bad_frame",
   message: "unrecognised control frame" }`;
8. `rc.hello` with `role: "host"` → the host hello; with `role: "client"` → the
   client hello;
9. any other frame while `clientId === null` or `phase === "unhelloed"` →
   `rc.refused { ref?, code: "hello_required", message: "say hello first" }`;
10. on a host socket (`host: true`): `rc.resync` → host resync; `rc.command_result`
    → §8.6; `rc.close` → `end("closed_by_owner", owner)`; `rc.control_answer`,
    `rc.kick`, `rc.take_over`, `rc.grant_control` → §8.7/§8.8; anything else →
    `rc.refused { ref?, code: "bad_frame", message: "the host does not send <t>" }`;
11. on a client socket: `rc.resync` or `rc.command_result` → `rc.refused { ref?,
    code: "not_host", message: "only the host sends that" }`; `rc.ack` → §8.5;
    `rc.command` → §8.6; `rc.close` → when `role !== "owner"`, `rc.refused {
    code: "not_driver", message: "only the room owner may close the room" }`,
    else `end("closed_by_owner", owner)`; `rc.request_control`,
    `rc.release_control`, `rc.control_answer`, `rc.kick`, `rc.take_over`,
    `rc.grant_control` → §8.7/§8.8.

`ref` is the frame's `commandId` or, failing that, `requestId`, when it is a
string of at most 64 characters; otherwise omitted. Sizes are measured in UTF-8
bytes (`rcUtf8Bytes`), never `String.length`.

A refusal is a frame, never a close. The refusal frame:

```json
{ "t": "rc.refused", "ref": "<optional>", "code": "<RcRefusalCode>", "message": "<text>", "retryAt": <optional ms> }
```

**Host hello** (`rc.hello`, `role: "host"`), in order:

1. socket not on the host door → `rc.refused { code: "not_host", message: "a
   host says hello on the host socket" }`;
2. `protocol !== 1` → `rc.error { code: "protocol_unsupported", message: "this
   server speaks rc protocol 1" }`, then close `4400 "protocol unsupported"`,
   then `forget()`;
3. `clientId !== null` already → `rc.refused { code: "already_hello", message:
   "this socket said hello already" }`;
4. the secret check: `hostSecret` is present, `host_secret_hash` is stored, and
   `timingSafeEqual(sha256Hex(hostSecret), host_secret_hash)` where `sha256Hex`
   is the lowercase hex of SHA-256 over the UTF-8 bytes and `timingSafeEqual`
   compares two equal-length strings by OR-ing the XOR of every char code (false
   at once on unequal lengths);
5. if the principal is not `owner_user_id`, or `clientId !== owner_client_id`,
   or the secret check failed: `rc.refused { code: "not_host", message: "this
   socket is not the room's host" }`, close `4403 "not the host"`, remove from the
   map, audit `host_refused` (detail `{ clientId }`), log `rc_host_refused`.
   The secret is compared, dropped, never logged;
6. **supersede**: if another host socket is live it is closed `4409
   "superseded"` and removed from the map;
7. this socket becomes the host: `host = true`, `clientId`, `helloAt = now`,
   `ready = true`, `phase = "ready"`, attachment re-serialised, `hostWs = this`,
   `lastHostFrameAt = now`;
8. `wants` is `"snapshot"` when `hello.as_of_seq !== head` or `resyncHold` is
   set, else `"nothing"`; `hostOwesSnapshot = (wants === "snapshot")`;
9. **sends**, in order: the host welcome; the full roster; one
   `rc.control_request { request }` per pending request in `requested_at`
   order; if the owner had been offline, `rc.owner { online: true }` to every
   helloed client; the roster is marked dirty (every client gets it on the tick);
10. **then writes**: if the owner had been offline or `host_first_hello_by` was
    set, `UPDATE room_state SET owner_offline_at = NULL, host_first_hello_by =
    NULL`; audit `host_superseded` if step 6 closed one (detail `{}`); audit
    `host_online` (detail `{ wants }`); log `rc_host_online`;
11. if any client is `parked`, `requestSnapshot("joiner")`;
12. if no host was connected before (not a supersede), the directory is marked
    dirty; `flushDirectory()`; `rearm()`.

The host welcome, field by field:

```json
{
  "t": "rc.welcome",
  "protocol": 1,
  "roomId": "<room id>",
  "orgId": "<scope org id or null>",
  "workspaceId": "<scope workspace id or null>",
  "role": "host",
  "head": <newest seq the room holds; 0 when none>,
  "driverEpoch": <epoch>,
  "driver": { "id": "...", "kind": "user|guest|link", "name": null },
  "snapshotAsOf": <stored snapshot's as_of_seq or null>,
  "wants": "snapshot" | "nothing"
}
```

`driver` is `{ id: driver_id ?? owner_user_id, kind: driver_kind ?? "user", name:
driver_name }`. The host's own hello fields `capabilities`, `agent` and `model`
are validated by the schema and otherwise not stored by the object (the
create door recorded them).

**Client hello** (`rc.hello`, `role: "client"`), in order:

1. socket on the host door → `rc.refused { code: "bad_frame", message: "the host
   socket says hello as the host" }`;
2. `protocol !== 1` → `rc.error` + close `4400` + forget, as above;
3. `clientId !== null` and `phase !== "unhelloed"` → `rc.refused { code:
   "already_hello", message: "this socket said hello already" }`;
4. if `phase === "unhelloed"` (a re-hello after `rc.resync { reason: "ahead" }`):
   drop re-hello timestamps older than 60 000 ms; if 3 remain → `rc.refused {
   code: "rate_limited", message: "too many re-hellos; reconnect later" }`, close
   `1001 "re-hello limit"`, forget; else record this one;
5. else (a first hello): count the **other** client sockets (`others`, hello or
   not) and, among them, the helloed ones of this principal (`mine`); if
   `others >= 64` or `mine >= 4` → `rc.refused { code: "room_full", message:
   "this room is full; try again later" }`, close `1013 "room full"`, forget, log
   `rc_room_full`;
6. record `clientId`, `surface`, `since`; `ready = false`; `helloAt = joinAt =
   now`; `sentSeq = ackedSeq = since`; `inflight = []`; `unackedBytes = 0`;
   `lagSince = null`; attachment re-serialised;
7. if `driver_lost_at !== null` and this principal is the driver: `UPDATE
   room_state SET driver_lost_at = NULL`; roster marked dirty (the driver is
   back inside the grace);
8. send the client welcome;
9. if `since > head` → `phase = "unhelloed"`, send `rc.resync { as_of_seq: 0,
   reason: "ahead" }`, stop (a replica claiming seqs this room never numbered
   starts over; nothing it sends is taken until it says hello again);
10. else `enqueueJoin()` (§8.5).

The client welcome, field by field:

```json
{
  "t": "rc.welcome",
  "protocol": 1,
  "roomId": "<room id>",
  "role": "owner" | "member" | "link",
  "principal": { "id": "...", "kind": "user", "name": null },
  "tier": "view" | "steer" | "steer_approve",
  "driverEpoch": <epoch>,
  "driver": { "id": "...", "kind": "...", "name": null },
  "ownerOnline": <hostWs !== null>,
  "head": <newest seq>,
  "tailFloor": <oldest seq the ring holds>,
  "pending": [ <ControlRequest>... ]
}
```

`role` is the attachment's role (`"member"` if somehow `null`). `pending` is
every pending control request when the principal is the owner or the current
driver, else only the principal's own (§8.8). `roomId` is always sent today
(there are no link sockets yet).

**Roster frames.** A roster is always whole, never a delta. The full roster
goes to the host and to every client whose role is not `link`:

```json
{
  "t": "rc.roster",
  "scope": "full",
  "driverEpoch": <epoch>,
  "ownerOnline": <boolean>,
  "driver": { "id": "...", "kind": "...", "name": null, "lost": true? },
  "peers": [
    { "peerId": "<clientId>", "id": "<principal id>", "kind": "user", "name": null,
      "surface": "web|mobile|desktop", "role": "owner|driver|visitor",
      "tier": "...", "since": <connectedAt> }
  ]
}
```

`peers` is every helloed client socket not in `unhelloed` (the host socket is
never a peer); `surface` defaults to `web`; `role` is `owner` when the peer is
the owner, else `driver` when it is the driver, else `visitor`. `driver.lost` is
present (`true`) only while `driver_lost_at` is set.

The guest roster goes to a client whose role is `link`:

```json
{
  "t": "rc.roster",
  "scope": "guest",
  "driverEpoch": <epoch>,
  "ownerOnline": <boolean>,
  "driver": { "kind": "...", "name": null, "lost": true? },
  "you": "driver" | "visitor",
  "counts": { "members": <distinct peer ids with kind user>, "visitors": <distinct peer ids with other kinds> }
}
```

When rosters are sent:

- to the host, directly after its welcome;
- to a client, as the last frame of its first catch-up (after `rc.synced`),
  scoped for that client;
- to the host and every `ready` client on the next 100 ms tick whenever the
  roster is marked dirty: a hello completes, a helloed socket closes, the seat
  changes (`setDriver`), a driver is lost or returns, the member tier changes,
  the host connects or leaves, the scope is revoked, a member is cut;
- immediately (`flushRoster()` outside the tick) when a control request is
  approved, host first then clients (§8.8).

**Silence sweep.** On every alarm while the room is open: the host is closed
`1001 "silent"` and treated as gone when `now − lastHeard(host) > 45 000`; a
client is closed `1001 "silent"` and forgotten when `now − lastHeard > 120 000`
(roster marked dirty if it had helloed). The alarm runs at least every 15 000 ms
while a host is connected, so a dead host is seen within 60 s.

**Closing and forgetting.** `close(ws, code, reason)` calls `ws.close` and
swallows an already-closing error. `forget(ws)` removes the socket from the
map and the join queue and serialises a `null` attachment onto it, so a late
frame on a forgotten socket cannot rebuild its state through
`deserializeAttachment` (step 1 of the frame handling ignores it). The
runtime's `webSocketClose(ws, code)` closes the server side with the same code
(`1005` becomes `1000`) and reason `"closing"`, then runs `socketGone(ws,
"close")`; `webSocketError` runs `socketGone(ws, "close")` too.

`socketGone(ws, reason)`:

1. no state for it → return;
2. `forget(ws)`;
3. if it was the host → `hostGone(reason)` (below), return;
4. if it had helloed → roster dirty;
5. if the room is open, the principal is not the owner, and no other client
   socket of this principal remains → `cancelRequestsOf(principal, "left")`;
6. if the room is open, the principal is the driver, the driver is not the
   owner, `driver_lost_at` is `NULL`, and no other client socket of this
   principal remains → `UPDATE room_state SET driver_lost_at = now`; roster
   dirty (the driver shows as `lost`); `rearm()`.

**Host-offline grace** (`hostGone`):

1. `hostWs = null`; if the room is not open, stop;
2. `graceEndsAt = now + offline_grace_ms` (the `rc_offline_grace_ms` limit the
   room was created under; default 3 600 000 ms);
3. send `rc.owner { online: false, graceEndsAt }` to every helloed client;
   roster dirty;
4. every `parked` client is served best-effort (§8.5);
5. `snapshotRequestedAt = null`; the ring is checkpointed now;
6. `UPDATE room_state SET owner_offline_at = now, snapshot_requested_at = NULL`;
7. audit `host_offline` (actor the owner; detail `{ reason: "close" | "silent" }`);
   log `rc_host_offline`;
8. directory marked dirty (`host_online` goes to `0`); `flushDirectory()`;
   `rearm()`.

While offline: commands fail `owner_offline` at once; control requests are
refused `owner_offline`; joiners never park. When the alarm finds `hostWs ===
null` and `now >= owner_offline_at + offline_grace_ms`, the room ends
`owner_timeout`. When the host returns inside the grace, step 9 of the host
hello tells every client `rc.owner { online: true }`.

**Ending** (`end(reason, actor, detail)`), idempotent (a second call while
`status !== "open"` returns at once):

1. to every socket in the map, host and clients, in map order: send
   `rc.closed { reason }`, close `4410 "room closed"`, `forget()`;
2. `hostWs = null`; join queue, ring, `ringBytes`, `ringDirty`, `assembling`,
   `snapshotAsOf`, `snapshotRequestedAt` cleared; the checkpoint timer cancelled
   and its `waitUntil` promise settled;
3. `purgeAt` is `now` for `erased`, else `now + 604 800 000`;
4. one transaction:
   ```sql
   UPDATE room_state SET status = 'ended', ended_at = ?now, end_reason = ?reason, purge_at = ?purgeAt,
     owner_offline_at = NULL, host_first_hello_by = NULL, snapshot_requested_at = NULL,
     tail_bytes = 0, d1_pending = 1, d1_retry_at = ?now, d1_attempts = 0 WHERE id = 1;
   DELETE FROM tail_checkpoint;
   DELETE FROM snapshot;
   DELETE FROM rc_commands;
   UPDATE rc_control_requests SET status = 'declined', answered_at = ?now, reason = 'room_closed' WHERE status = 'pending';
   ```
5. audit `room_closed` for `closed_by_owner` / `closed_by_admin`, else
   `room_ended` (actor as given; detail is the caller's detail plus `reason`);
6. `flushDirectory()` (the row is marked ended); `rearm()` (the purge alarm).

What is kept until the purge: `room_state` (with `end_reason`, `purge_at`),
`audit`, `rc_control_requests` (resolved), `revoked_members`, `kicked`. What
is deleted at once: the tail, the snapshot, the commands.

**Close codes**, every point they are used:

| code | name | used when |
| --- | --- | --- |
| `1001` | Idle | no hello within 10 s (either door); the re-hello limit; the client silence sweep; the host silence sweep |
| `1008` | Revoked | a member cut by scope revocation, a member removed from the Organisation, or a kick |
| `1013` | TryAgainLater | `room_full`; a lagging viewer cut |
| `4400` | ProtocolUnsupported | a hello with `protocol !== 1` (either door) |
| `4403` | Forbidden | a host hello that failed the owner / `clientId` / secret check |
| `4409` | Superseded | the previous host socket when a newer one proves itself |
| `4410` | RoomClosed | every socket when the room ends, after `rc.closed` |

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`upgrade`,
`webSocketMessage`, `hostHello`, `clientHello`, `socketGone`, `hostGone`, `end`).

### 8.5 Relay

**The binary frame.** Every binary message is one frame:

```text
version u8 (= 1) | kind u8 | flags u8 | seq_first varint | count varint | payload…
kind 1 = delta batch: count × (len varint | redacted SessionDeltaEnvelope JSON), seqs seq_first … seq_first + count − 1
kind 2 = one snapshot part: seq_first = as_of_seq, count = 1, flags bit 0 (0x01) = another part follows
```

Varints are unsigned LEB128, at most 8 bytes, at most `Number.MAX_SAFE_INTEGER`.
The object decodes the header and treats the payload as opaque bytes.

**Binary frame handling (`binary`)**, in order:

1. socket not the host: on the host door → `rc.refused { code: "hello_required",
   message: "say hello first" }`; on the member door → `rc.refused { code:
   "not_host", message: "only the host sends stream frames" }`;
2. `lastHostFrameAt = now`;
3. `bytes.length > 262 144` → `rc.refused { code: "payload_too_large", message:
   "a stream frame is at most 262144 bytes" }`;
4. the header does not decode (fewer than 3 bytes; a truncated or over-long
   varint) → `rc.refused { code: "bad_frame", message: "unreadable frame header" }`;
5. `rcFrameProblem` names a problem → `rc.refused { code: "bad_frame", message }`
   with one of: `"frame version <v> is not 1"`, `"frame kind <k> is not a delta
   batch (1) or a snapshot (2)"`, `"count is at least 1"`, `"a snapshot part has
   count 1"`, `"seq out of range"`;
6. kind 2 → the snapshot-part path (below); stop;
7. `resyncHold` set → `rc.refused { code: "snapshot_required", message: "send the
   snapshot the resync promised first" }`;
8. `seqFirst <= head` → `rc.refused { code: "seq_regressed", message: "seq <s> is
   not past <head>" }`;
9. `gap = seqFirst > head + 1`;
10. **relay** (`relayLive`): one pass over the socket map; every non-host socket
    in phase `ready` gets the frame as it arrived, except one with `lagSince`
    set, which gets nothing (and is cut if `now − lagSince > 10 000`);
11. **then** bookkeeping: if `gap`, `gapAfter = head` (if not already set),
    `snapshotOwed = true`, `requestSnapshot("gap")`; the frame is pushed on the
    ring; `ringBytes += length`; `head = seqLast`; `bytesSinceSnapshot +=
    length`; `ringDirty = true`; `evict()`; stats counted; `afterHostFrame()`
    (the checkpoint debounce).

Nothing is written to storage on this path. The relay-before-store rule also
holds for the host hello (sends before the `UPDATE`) and for a relayed command
(the host is sent the frame before the `rc_commands` row is inserted).

**Sending a binary frame to a client** (`sendFrame`): `ws.send(bytes)` (a throw
means the socket is closing; its close handler tidies up); `sentSeq =
max(sentSeq, seq)`; `inflight.push({ seq, bytes })`; `unackedBytes += bytes`;
when `unackedBytes > 2 097 152` and `lagSince` is `null`, `lagSince = now` and
`rearm()` (the lag deadline joins the alarm).

**The ring and its cap** (`evict`): the cap is `tail_limit` (the room's
`rc_tail_bytes`). While `ringBytes > cap` and the ring is non-empty: let
`oldest` be the first frame; it is *covered* when a snapshot is stored and
`oldest.seqLast <= snapshotAsOf`. If it is not covered, `ringBytes <= cap +
1 048 576` and a host is connected, `requestSnapshot("stale")` and stop (the
ring over-holds by at most one snapshot's worth until the snapshot arrives);
otherwise drop the oldest: `ringBytes -= length`, `tailFloor = oldest.seqLast +
1`, `gapAfter = null` if it fell below the floor, `ringDirty = true`.

**Checkpoint.** `afterHostFrame(now)`: if the ring is dirty and `dirtySince`
is `0`, `dirtySince = now`; if dirty and `now − dirtySince >= 30 000`,
checkpoint now; otherwise (re)start the 1 000 ms debounce timer (held open with
`waitUntil`). On the debounce firing (`checkpointQuiet`): checkpoint, and if
`bytesSinceSnapshot >= tail_limit / 2`, `requestSnapshot("checkpoint")`.
`checkpoint(now)` does nothing unless the ring is dirty and the room is open;
otherwise, in one transaction: `DELETE FROM tail_checkpoint`; the ring is packed
into chunks of at most 1 572 864 bytes (each frame as `varint(length) ||
bytes`), one `INSERT INTO tail_checkpoint(chunk, seq_first, seq_last, bytes,
at)` per chunk with `chunk` from 0; `UPDATE room_state SET head, tail_floor,
tail_bytes, gap_after, snapshot_owed, resync_hold, last_checkpoint_at`. Then
`ringDirty = false`, `dirtySince = 0`. The alarm also checkpoints when the ring
is dirty and `now − lastHostFrameAt >= 1 000`. `hostGone` checkpoints
unconditionally.

**Acks** (`rc.ack { seq }`, client only):

1. if `now − ackWindow.at >= 1 000` the window resets to `{ at: now, n: 0 }`;
2. `++n > 10` → ignored;
3. `seq < ackedSeq` or `seq > sentSeq` → ignored;
4. `ackedSeq = seq`; every `inflight` entry with `seq <= ack` is removed and its
   bytes subtracted from `unackedBytes`;
5. if `lagSince` is set and `unackedBytes <= 2 097 152`: `lagSince = null`; if
   the socket is `ready` and `sentSeq < head` (live frames were withheld while
   it lagged), `since = sentSeq` and `enqueueJoin()` — the frames it missed come
   from the ring as a catch-up before it is live again;
6. if the join queue is non-empty, `serveJoins(now)` (acks free budget).

**Cutting a lagging viewer** (`cutLagging`): send `rc.resync { as_of_seq: head,
reason: "lagging" }`, close `1013 "lagging"`, count `slow_drops`, log
`rc_slow_drop`, `forget()`. Triggered from `relayLive` when a frame arrives for
a socket lagging more than 10 000 ms, and from the alarm (deadline `lagSince +
10 001`). The host is never cut for lag.

**Joins.** `enqueueJoin(ws, s)`: `phase = "queued"`, append to the queue if
absent, `serveJoins(now)`, schedule the tick if anything still waits.

`serveJoins(now)`, front of the queue first:

1. a socket no longer in the map or no longer `queued` is dropped from the queue;
2. `plan = joinPlan(since)`; a `wait` plan parks the socket (below) and continues;
3. `cost = snapshotBytes + Σ frame bytes`; `inflight = Σ unackedBytes` over
   client sockets; if `inflight > 0` and `inflight + cost > 16 777 216` → stop
   (the tick retries); a room with nothing in flight always admits one joiner,
   whatever its cost;
4. dequeue and `deliver(plan)`.

`joinPlan(since)`:

1. `resyncHold` → `wait`;
2. the ring runs unbroken from `since + 1` to `head` (`framesAfter(since)`:
   frames whose `seqLast > since`, each `seqFirst <= expected`, ending at or
   past `head`) → serve those frames, no snapshot (`from: "none"`);
3. a snapshot is stored, `since < snapshotAsOf`, and the ring runs unbroken from
   `snapshotAsOf + 1` to `head` → serve the snapshot then those frames (`from:
   "held"`);
4. else `wait`.

`park(ws, s, now)`: if no host is connected and `resyncHold` is not set →
`deliverBestEffort` (below); else `phase = "parked"`, and unless `resyncHold`
is set (the snapshot is already on its way), `requestSnapshot("joiner")`;
`rearm()`.

`deliver(ws, s, plan, now)`, in order: the stored snapshot in parts (if the
plan says so); every plan frame via `sendFrame`; `rc.synced { head }`; `phase =
"ready"`, `ready = true`, `sentSeq = max(sentSeq, head)`, attachment
re-serialised; on the socket's **first** delivery, its scoped roster is sent and
the roster is marked dirty; log `rc_join { surface, ttfp_ms, snapshot_bytes,
tail_frames, served_from }`.

`deliverBestEffort(ws, s, now)`: no snapshot is coming (owner offline, or the
host did not answer in 10 s). Serve the stored snapshot if one exists and `since
< snapshotAsOf`, then every ring frame with `seqLast > floor` (where `floor` is
`snapshotAsOf` or `since`), then `rc.synced`, then `rc.refused { code:
"snapshot_unavailable", message: "the desktop has not sent a snapshot; the
transcript may be incomplete" }` so the page can say "waiting for the desktop"
rather than render half a transcript as whole.

**Serving the stored snapshot** (`sendSnapshot`): `SELECT as_of_seq, bytes FROM
snapshot WHERE id = 1`; `parts = max(1, ceil(length / 262 125))`; part `i` is a
kind-2 frame with `flags = 0x01` for every part but the last, `seqFirst =
as_of_seq`, `count = 1`, payload the `i`-th 262 125-byte slice; each goes
through `sendFrame` with `seq = as_of_seq`.

**Requesting a snapshot** (`requestSnapshot(reason)`): nothing when no host is
connected; nothing when a request is already in flight (`snapshotRequestedAt`
set and younger than 10 000 ms); else send `rc.snapshot_request { reason }` with
`reason` one of `"joiner" | "gap" | "stale" | "checkpoint"`, `snapshotRequestedAt
= now`, `UPDATE room_state SET snapshot_requested_at = now`. On the alarm, when
the request is 10 000 ms old, `snapshotRequestedAt = null` and every `parked`
socket is served best-effort.

**Receiving a snapshot part** (`snapshotPart(asOf, flags, payload)`):

1. the part is *wanted* when assembly is in progress, a request is outstanding,
   `resyncHold` is set or `hostOwesSnapshot` is set; an unwanted part arriving
   within 5 000 ms of the last stored snapshot is dropped silently;
2. a new `asOf` (or no assembly) starts a fresh assembly `{ asOf, parts: [],
   bytes: 0 }`; the payload is copied in;
3. `bytes > 1 048 576` → assembly dropped, `rc.refused { code:
   "payload_too_large", message: "a snapshot is at most 1048576 bytes" }`;
4. flag bit 0 set → wait for the next part;
5. last part: the parts are concatenated and **stored first**:
   ```sql
   INSERT INTO snapshot(id, as_of_seq, parts, bytes, at) VALUES (1, ?asOf, ?parts, ?bytes, ?now)
     ON CONFLICT(id) DO UPDATE SET as_of_seq = excluded.as_of_seq, parts = excluded.parts,
       bytes = excluded.bytes, at = excluded.at
   ```
6. `snapshotAsOf = asOf`; `lastSnapshotAt = now`; `bytesSinceSnapshot = 0`;
   `hostOwesSnapshot = false`; `snapshotRequestedAt = null`;
7. if `asOf >= head`: the ring is emptied, `head = asOf`, `tailFloor = asOf +
   1`, `gapAfter = null` (the snapshot is the whole truth up to `asOf`);
   else if `gapAfter` is set and the snapshot reaches the first frame past the
   gap (`asOf >= resumed.seqFirst − 1`, or no such frame): frames with `seqLast
   <= asOf` are dropped from the front, `tailFloor = max(tailFloor, asOf + 1)`,
   `gapAfter = null`;
8. `snapshotOwed = (gapAfter !== null)`; `resyncHold = false`; `ringDirty =
   true`; `UPDATE room_state SET snapshot_requested_at = NULL`; `evict()`;
9. `releaseWaiting()`: every `parked` or `resync` socket becomes `queued` and
   joins the queue; the tick is scheduled;
10. `afterHostFrame(now)`.

**Host resync** (`rc.resync { as_of_seq }` from the host): for every client
socket, if `ready` send `rc.resync { as_of_seq, reason: "host" }`; if `ready`,
`queued` or `parked`, set `phase = "resync"`, `since = 0`, `sentSeq = as_of_seq`,
`ackedSeq = min(ackedSeq, as_of_seq)`, `inflight = []`, `unackedBytes = 0`,
`lagSince = null`. Then the join queue and the ring are emptied; `head =
as_of_seq`; `tailFloor = as_of_seq + 1`; `gapAfter = null`; `snapshotOwed`,
`resyncHold`, `hostOwesSnapshot`, `ringDirty` all `true`; `resyncs` counted;
audit `resync` (actor the owner; detail `{ as_of_seq }`); `afterHostFrame`.
Until the snapshot arrives every delta is refused `snapshot_required`, and
every joiner waits.

**The 100 ms tick** (`scheduleTick`): one timer at a time, held open with a
`waitUntil` promise; on firing: `flushRoster()`, `serveJoins(now)`, and the
tick is rescheduled while the queue is non-empty or the roster is dirty.

**Client-side resync frames**, all three shapes:

```json
{ "t": "rc.resync", "as_of_seq": <n>, "reason": "host" }      // discard what you hold at or below n; a snapshot follows
{ "t": "rc.resync", "as_of_seq": 0, "reason": "ahead" }       // you were un-helloed; hello again with since 0
{ "t": "rc.resync", "as_of_seq": <head>, "reason": "lagging" } // the socket closes 1013 next; reconnect with since
```

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`binary`, `relayLive`,
`evict`, `checkpoint`, `ack`, `serveJoins`, `joinPlan`, `snapshotPart`,
`hostResync`).

### 8.6 Commands

**`rc.command` from a client.** The frame:

```json
{ "t": "rc.command", "commandId": "<ULID>", "driverEpoch": <epoch>, "command": { "kind": "...", ... } }
```

`commandId` matches `/^[0-9A-HJKMNP-TV-Z]{26}$/`. There is no `from`: the object
stamps the sender from the socket. The seven command shapes (strict objects):

| kind | fields | min tier | capability (host side) |
| --- | --- | --- | --- |
| `submit` | `content` (≥ 1 char), `clientMessageId?` (≤ 64) | `steer` | `steer` |
| `stop` | — | `steer` | `steer` |
| `answer_permission` | `requestId` (1–128), `optionId` (1–128) | `steer_approve` | `approve` |
| `answer_elicitation` | `requestId` (1–128), `answer` (any JSON) | `steer_approve` | `approve` |
| `set_mode` | `modeId` (1–100) | `steer` | `mode` |
| `set_model` | `modelId` (1–200) | `steer` | `model` |
| `set_config_option` | `key` (1–100), `value` (any JSON) | `steer` | `config` |

`rcTierAllows(tier, kind)` is `index(tier) >= index(minTier)` over `["view",
"steer", "steer_approve"]`. `set_config_option` is additionally members-only
(`principal.kind === "user"`).

The gate (`command(ws, s, frame, now)`), **in this order**; a refusal through
`refuse(gate, code, message)` sends to the sender:

```json
{ "t": "rc.command_result", "commandId": "<id>", "ok": false, "refusedBy": "relay", "gate": "<gate>", "code": "<code>", "message": "<text>" }
```

(`gate` omitted when the step says `null`), audits `command_refused` (detail
`{ kind, gate: gate ?? code, side: "relay" }`) and logs `rc_command`.

1. **Dedup first.** `SELECT * FROM rc_commands WHERE from_id = ?principal AND
   command_id = ?commandId`. A row found is a resend: if `status = 'pending'` or
   `result IS NULL`, send `{ "t": "rc.command_result", "commandId", "ok": null,
   "status": "pending" }`; else send the stored `result` frame verbatim. Never a
   second relay. Stop.
2. room not open → `refuse("room_closed", "room_closed", "this room has ended")`.
3. no host socket → `refuse("owner_offline", "owner_offline", "the owner's
   desktop is offline")`. Nothing is held for an absent owner.
4. the principal's bucket (`RateBucket(limits.rc_command_burst, 2)`, created on
   first use, keyed by principal id) has no token → `rc.refused { ref:
   commandId, code: "rate_limited", message: "too many commands; slow down" }`
   (a refusal frame, not a result; no audit).
5. `rcCommandSizeProblem(command)` → `refuse(null, "payload_too_large", <problem>)`
   where the problem is `"a prompt is at most 32768 bytes"` (UTF-8 bytes of
   `submit.content`) or `"a value is at most 8192 bytes serialised"`
   (`JSON.stringify` of `answer` / `value`).
6. `!rcTierAllows(s.tier, kind)` → `refuse("tier", "tier", "your tier (<tier>)
   does not allow <kind>")`.
7. `kind` in `RC_MEMBERS_ONLY_COMMANDS` and `principal.kind !== "user"` →
   `refuse("tier", "tier", "<kind> is for signed-in members only")`.
8. **Driver-only, the owner included.** Let `owner = principal.id ===
   owner_user_id`. Unless (`owner` and `kind === "stop"`), if `principal.id !==
   driver_id`: when `owner`, send
   ```json
   { "t": "rc.command_result", "commandId": "<id>", "ok": false, "refusedBy": "relay",
     "gate": "not_driver", "code": "not_driver",
     "message": "somebody else is driving; take over to steer", "takeOver": true }
   ```
   audit `command_refused` (`{ kind, gate: "not_driver", side: "relay" }`), log,
   stop; when not the owner, `refuse("not_driver", "not_driver", "only the
   driver may steer")`. `stop` is the owner's one exemption: the master's kill
   switch is never seat-gated.
9. `frame.driverEpoch !== driver_epoch` → `refuse("epoch_stale", "epoch_stale",
   "the driver changed; the epoch is <epoch>")`.
10. **Relay to the host first**, the relayed-command frame:
    ```json
    { "t": "rc.command", "commandId": "<id>", "driverEpoch": <frame.driverEpoch>,
      "from": { "id": "<principal id>", "kind": "user", "name": null },
      "command": { ...the command as received } }
    ```
11. **Then storage**: `INSERT INTO rc_commands(from_id, command_id, kind, at,
    status, result) VALUES (?, ?, ?, ?now, 'pending', NULL)`; then trim:
    ```sql
    DELETE FROM rc_commands WHERE rowid IN (
      SELECT rowid FROM rc_commands WHERE status != 'pending' ORDER BY at DESC LIMIT -1 OFFSET 500)
    ```
12. audit `command_relayed` (`commandId`, `driverEpoch`; detail per §8.11);
    `rearm()` (the 30 s timeout joins the alarm).

**`rc.command_result` from the host.** Two shapes, both strict:

```json
{ "t": "rc.command_result", "commandId": "<ULID>", "fromId": "<principal id>", "ok": true }
{ "t": "rc.command_result", "commandId": "<ULID>", "fromId": "<principal id>", "ok": false,
  "refusedBy": "desktop", "gate": "<RcGate>", "code": "<1–64 chars>", "message": "<≤ 500 chars>" }
```

`fromId` echoes the relayed frame's `from.id`: commands are keyed `(from,
commandId)`, so the same id from two principals is two commands. Handling:

1. `SELECT * FROM rc_commands WHERE from_id = ?fromId AND command_id =
   ?commandId`; no row, or `status !== 'pending'` → ignored silently;
2. the frame to the sender is `{ t: "rc.command_result", commandId, ok: true }`
   or `{ t, commandId, ok: false, refusedBy: "desktop", gate, code, message }`;
   it is sent to **every** client socket of `fromId` (`sendToPrincipal`);
3. `UPDATE rc_commands SET status = 'done' | 'refused', result = <frame JSON>`;
4. audit `command_result` (actor the owner; detail `{ kind, ok, gate: ok ? null
   : gate, code: ok ? null : code }`); log `rc_command` with `rtt_ms`.

**Relay timeout** (`expireCommands`, on the alarm): every `pending` row with `at
<= now − 30 000` gets

```json
{ "t": "rc.command_result", "commandId": "<id>", "ok": false, "refusedBy": "relay",
  "code": "relay_timeout", "message": "the desktop did not answer in time; it may still have acted" }
```

sent to every socket of its principal (no `gate`), `status = 'timed_out'`,
`result` stored, audit `command_timed_out` (actor `system`, `subject` the sender;
detail `{ kind }`). `relay_timeout` means "no answer", never "refused".

The `RcGate` vocabulary a result may name, in gate order:
`platform_flag`, `org_setting`, `org_policy`, `room_closed`, `owner_offline`,
`link_revoked`, `link_expired`, `member_removed`, `tier`, `not_driver`,
`epoch_stale`, `rate_limited`, `owner_only`, `option_standing`, `widening`,
`in_flight`, `not_pending`. The object itself emits `room_closed`,
`owner_offline`, `tier`, `not_driver`, `epoch_stale`; the rest come from the
desktop.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`command`,
`commandResult`, `expireCommands`, `bucketFor`).

### 8.7 Seat and master frames

**Driver state.** `driver_id`, `driver_kind`, `driver_name` name the seat's
principal; `driver_epoch` starts at 1. `setDriver(principal)` is the only
writer:

```sql
UPDATE room_state SET driver_id = ?1, driver_kind = ?2, driver_name = ?3, driver_lost_at = NULL,
  driver_epoch = driver_epoch + 1 WHERE id = 1
```

then the roster is marked dirty. Nothing is sent by `setDriver` itself:
everyone learns the new seat and epoch from the roster on the next tick, and a
command issued under the old epoch is `epoch_stale` wherever it was typed.
`seatToOwner()` is `setDriver({ id: owner_user_id, kind: "user", name: null })`.

**The master frames** (`controlOperation`): `rc.take_over`, `rc.grant_control {
target }`, `rc.kick { target }` and `rc.control_answer { requestId, approve }`,
accepted from the host socket or from any of the owner's client sockets (the
owner on their phone is the owner), **never gated by who is driving**. Checks,
in order:

1. `owner = s.host || s.role === "owner"`; a non-owner sending anything but
   `rc.control_answer` → `rc.refused { code: "not_driver", message: "only the
   room owner may do that" }`;
2. the socket's op bucket (`RateBucket(5, 1)`: burst 5, refill 1/s, created on
   first use) has no token → `rc.refused { code: "rate_limited", message: "slow
   down" }`;
3. room not open → `rc.refused { code: "room_closed", message: "this room has
   ended" }`;
4. by frame:

| frame | rule |
| --- | --- |
| `rc.control_answer` | a non-owner who is not the driver → `rc.refused { ref: requestId, code: "not_driver", message: "only the driver or the room owner may answer" }`; else §8.8 |
| `rc.take_over` | no-op while the owner drives; else `seatToOwner()`; audit `taken_over` (actor the owner; `subject` the previous driver; `driverEpoch` the new epoch; detail `{}`); log `rc_seat { change: "taken_over" }` |
| `rc.grant_control { target }` | `target === owner_user_id` → `seatToOwner()` if somebody else drives, else no-op, no audit; `target === driver_id` → no-op; else the target must have a helloed client socket not in `unhelloed` (`rc.refused { code: "request_unknown", message: "that person is not in the room" }` otherwise) and a tier that allows `submit` (`rc.refused { code: "tier", message: "their tier (<tier>) does not allow steering; change the room's member tier first" }` otherwise); then `setDriver(target.principal)`; audit `control_granted` (actor the owner; `subject` the target; `driverEpoch`; detail `{ kind: target.principal.kind }`); log `rc_seat { change: "granted" }` |
| `rc.kick { target }` | `target === owner_user_id` → no-op; `wasDriver = target === driver_id`; `cut = cutMember(target, 1008, "removed by the room owner", "kicked")` (every client socket of the target closed `1008` and forgotten, roster dirty if any, their pending requests cancelled with reason `kicked`); `DELETE FROM kicked WHERE until <= now`; `INSERT INTO kicked(principal_id, until) VALUES (?target, ?now + 600000) ON CONFLICT(principal_id) DO UPDATE SET until = excluded.until`; if `wasDriver`: `seatToOwner()` and audit `driver_kicked` (actor the owner; `subject` target; `driverEpoch`; detail `{ sockets: cut }`); else if `cut > 0`: audit `visitor_kicked` (actor the owner; `subject` target; detail `{ sockets: cut }`) |

A kick is sticky: while `kicked.until > now` every **socket** dial by that
principal into this object answers `404 not_found "no such room"` at the
object's `fetch` (the REST doors still answer them: their invite stands; a kick
is not an un-invite). After `RC_KICK_MS` (600 000 ms) the dial is admitted
again.

**`rc.release_control`** (a client frame), in order:

1. the principal is not the driver → `rc.refused { code: "not_driver", message:
   "only the driver may release control" }`;
2. the principal is the owner → no-op (the owner holding the seat has nothing to
   release);
3. op bucket empty → `rc.refused { code: "rate_limited", message: "slow down" }`;
4. `seatToOwner()`; audit `control_released` (actor the driver; `driverEpoch`;
   detail `{ reason: "released" }`); log `rc_seat { change: "released" }`.

**Driver-loss grace.** It starts in `socketGone` step 6: the driver is not the
owner, their last client socket has closed, and `driver_lost_at` is `NULL` →
`driver_lost_at = now`, the roster goes out with `driver.lost: true`, and the
alarm is armed for `driver_lost_at + 30 000`. It ends in one of three ways:

- the driver says hello again on any socket inside the grace (client hello step
  7): `driver_lost_at = NULL`, roster dirty — the seat is kept;
- the alarm finds `now >= driver_lost_at + 30 000`: `seatToOwner()`; audit
  `control_released` (actor `system`; `subject` the lost driver; `driverEpoch`;
  detail `{ reason: "driver_lost" }`); log `rc_seat { change: "driver_lost" }`;
- any other seat change (`setDriver` clears `driver_lost_at`).

Other seat returns, each via `seatToOwner()`: a member driver removed from the
Organisation (§8.9); a member driver whose tier is lowered below `steer` by
`/settings` (§8.3); the scope being revoked while a member drives (§8.9).

**`rc.close` from the host** ends the room `closed_by_owner` with the owner as
actor (§8.4), no bucket, no further check.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`controlOperation`,
`releaseControl`, `setDriver`, `seatToOwner`).

### 8.8 Arbitration (request to drive)

**The wire shape**, carried inside `rc.control_request { request }` and in
`rc.welcome.pending[]`:

```ts
interface RcControlRequest {
  requestId: string;                                   // a ULID
  from: { id: string; kind: "user" | "guest" | "link"; name: string | null };
  status: "pending" | "approved" | "declined" | "timed_out";
  requestedAt: number;
  expiresAt: number;
  answeredAt: number | null;
  reason: string | null;   // null, "access_revoked", "left", "kicked" or "room_closed"
}
```

It is built from a `rc_control_requests` row field for field (`request_id →
requestId`, `from_id/from_kind/from_name → from`, and so on).

**`rc.request_control`** (a client frame, no fields), in order:

1. op bucket (`RateBucket(5, 1)`) empty → `rc.refused { code: "rate_limited",
   message: "slow down" }`;
2. room not open → `rc.refused { code: "room_closed", message: "this room has
   ended" }`;
3. `!rcTierAllows(tier, "submit")` → `rc.refused { code: "tier", message: "your
   tier (<tier>) does not allow steering" }`;
4. the principal is the owner → `rc.refused { code: "not_accepting", message:
   "the owner takes the seat back with rc.take_over" }`;
5. the principal is the driver → `rc.refused { code: "not_accepting", message:
   "you are driving already" }`;
6. `accept_requests !== 1` → `rc.refused { code: "not_accepting", message: "this
   room does not take requests for control; ask the owner" }`;
7. no host socket → `rc.refused { code: "owner_offline", message: "the owner's
   desktop is offline; nobody can answer" }`;
8. `expireControlRequests(now)` (below);
9. an open request by this principal exists (`status = 'pending'`) → send
   `rc.control_request { request }` for it **to the asker alone**; stop
   (duplicates coalesce; nobody else is told again);
10. cooldown: the newest row of this principal with `status IN ('declined',
    'timed_out') AND reason IS NULL`, ordered by `answered_at DESC`; if
    `answered_at + 30 000 > now` → send to the asker
    ```json
    { "t": "rc.refused", "code": "cooldown", "message": "wait before asking again", "retryAt": <answered_at + 30000> }
    ```
    stop. Only a decline or a time-out starts the cooldown — a cancellation
    (`reason` set) never does;
11. the row: `request_id = ulid()`, `from_*` from the principal, `status =
    'pending'`, `requested_at = now`, `expires_at = now + 60 000`;
12. **sends first** (`tellAboutRequest`): the frame `{ "t": "rc.control_request",
    "request": <row> }` to the host socket, then to every helloed client socket
    (not `unhelloed`) whose principal is the asker, the owner, or — when the
    driver is a `user` other than those — the driver;
13. **then** `INSERT INTO rc_control_requests(request_id, from_id, from_name,
    from_kind, status, requested_at, expires_at) VALUES (…, 'pending', …)`;
14. audit `control_requested` (actor the asker; `requestId`; detail `{ kind:
    principal.kind, tier }`); log `rc_control_request { change: "requested" }`;
    `rearm()` (the expiry joins the alarm).

**`rc.control_answer { requestId, approve }`** (host, owner socket, or the
driver — after the §8.7 checks), in order:

1. `expireControlRequests(now)`;
2. `SELECT * FROM rc_control_requests WHERE request_id = ? AND status =
   'pending'`; no row (unknown, already answered, timed out) → `rc.refused {
   ref: requestId, code: "request_unknown", message: "no such control request" }`
   — a repeat answer is a no-op;
3. `asker` is the asker's first helloed client socket not in `unhelloed`;
4. **decline path** — `approve === false`, or no `asker` socket, or
   `!rcTierAllows(asker.tier, "submit")`: `reason` is `"access_revoked"` when
   `approve` was `true` (the asker is gone or can no longer steer), else `null`;
   `resolveRequest(row, "declined", answerer, reason)`; `tellAboutRequest`;
   audit `control_declined` (actor the answerer; `subject` the asker;
   `requestId`; detail `{ reason: reason ?? "declined" }`); log;
5. **approve path**: `resolveRequest(row, "approved", answerer, null)`;
   `setDriver(asker.principal)` (epoch + 1); **`flushRoster()` now** — the full
   roster to the host first, then to every ready client — so the asker's first
   command under the new epoch cannot reach a desktop whose epoch has not moved;
   **then** `tellAboutRequest(approved)` (the asker hears `status: "approved"`);
   audit `control_granted` (actor the answerer; `subject` the asker;
   `requestId`; `driverEpoch`; detail `{ kind: asker.principal.kind, via:
   "request" }`); log `rc_seat { change: "granted" }`.

`resolveRequest(row, status, by, reason, now)`:

```sql
UPDATE rc_control_requests SET status = ?1, answered_at = ?2, answered_by = ?3, reason = ?4
  WHERE request_id = ?5 AND status = 'pending'
```

and returns the wire shape with those fields applied.

**Expiry** (`expireControlRequests(now)`, run on the alarm and before every
request or answer): every `pending` row with `expires_at <= now` →
`resolveRequest(row, "timed_out", "system", null)`; `tellAboutRequest` (the
host, the owner's sockets, the driver's, the asker's); audit `control_timed_out`
(actor `system`; `subject` the asker; `requestId`; detail `{}`).

**Cancellation** (`cancelRequestsOf(principalId, reason)`): every `pending` row
of the principal → `resolveRequest(row, "declined", "system", reason)`;
`tellAboutRequest`; audit `control_declined` (actor `system`; `subject`;
`requestId`; detail `{ reason }`). Called with `"left"` when the asker's last
client socket closes (§8.4), `"kicked"` from `rc.kick`, and `"access_revoked"`
when a member is removed from the Organisation or the scope is revoked (§8.9).
`end()` resolves every pending row as `declined` with `reason = 'room_closed'`
in its transaction and tells nobody (every socket has just been closed).

**Late arrivals.** The host is sent one `rc.control_request` per pending
request directly after its welcome and roster (host hello step 9). A client
learns the open requests from `rc.welcome.pending`: all of them when the
principal is the owner or the driver, only their own otherwise. Nobody else
hears about a request.

The alarm deadline is `MIN(expires_at) WHERE status = 'pending'`.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`requestControl`,
`controlAnswer`, `resolveRequest`, `cancelRequestsOf`, `expireControlRequests`,
`tellAboutRequest`, `pendingFor`).

### 8.9 Scope on the object

**`POST /scope`** (`setScope`), after the §8.3 guards:

1. if `org_id` is already set: the same pair again (`orgId` equal and
   `workspaceId ?? null` equal) → `200 { orgId, workspaceId }` (the door retrying
   a PATCH whose directory write did not land; already done, not a second
   setting); a different pair → `409 rc_scope_set "this room's scope is set
   already"`;
2. `UPDATE room_state SET org_id = ?1, workspace_id = ?2 WHERE id = 1`;
3. audit `scope_set` (actor the owner; detail `{ orgId, workspaceId }`);
4. `200 { orgId, workspaceId }`.

Nothing is re-badged: a scope changes whom the owner *may invite*, not who is
in the room.

**`applyOrgEvent(event)`** — an RPC method called by the artifact-events
consumer's fan-out for every open room whose `rc_rooms.org_id` is the event's
Organisation. It answers the number of sockets it closed. If the room is not
open, has no scope, or its `org_id` differs from `event.org_id`, it answers 0.
By `event.kind`:

| kind | action |
| --- | --- |
| `org.deleted` | `revokeScopeAndTell("org_deleted")` |
| `member.removed`, `user_id` is the owner | `revokeScopeAndTell("owner_removed")` |
| `member.removed`, any other user | `cut = cutMember(user_id, 1008, "removed from the organisation", "access_revoked")`; if that user is the driver → `seatToOwner()`; `INSERT INTO revoked_members(user_id, at) VALUES (?, ?event.at) ON CONFLICT(user_id) DO NOTHING`; audit `member_revoked` (actor `system`; `subject` the user; detail `{ sockets: cut, reason: "member_removed" }`); answer `cut` |
| `member.added` | `DELETE FROM revoked_members WHERE user_id = ?` (the tombstone is lifted; re-invited, they may dial again); answer 0 |
| `member.role_changed` | answer 0 |

**`revokeScope(reason)`**, sends first:

1. every client socket with `role === "member"` is closed `1008 "the room is no
   longer shared"` and forgotten; `cut` counts them;
2. if `driver_id !== owner_user_id` → `seatToOwner()`;
3. for every distinct `from_id` with a pending request →
   `cancelRequestsOf(from_id, "access_revoked")` (every member is gone, so every
   request is);
4. `UPDATE room_state SET revoked_org_id = org_id, org_id = NULL, workspace_id
   = NULL WHERE id = 1`;
5. `DELETE FROM revoked_members`;
6. audit `scope_revoked` (actor `system`; detail `{ reason, sockets: cut }`);
   roster dirty; directory dirty; log `rc_scope_revoked`.

`revokeScopeAndTell` then runs `flushDirectory()` at once (the row is what the
dial door reads) and `rearm()`. The room continues solo: the owner's sockets
stay, the stream continues.

**Why the object clears the directory's pair, not the consumer.** The fan-out
finds rooms by `rc_rooms.org_id`. If the consumer cleared the column before
every object had heard, a redelivery after one object refused would find
nothing to redeliver to. So each object remembers the revoked scope in
`revoked_org_id` and clears its own row's pair on its next directory flush,
retried on its alarm until D1 takes it; until then the row still names the
Organisation and a redelivery reaches it.

**`flushDirectory()`**, never throws:

1. nothing to do unless `d1_pending = 1` and `room_id` is set;
2. `hostOnline = (status === 'open' && hostWs !== null) ? 1 : 0`;
3. one `db.batch` of:
   ```sql
   UPDATE rc_rooms SET status = ?1, ended_at = ?2, end_reason = ?3, purge_at = ?4, host_online = ?5
     WHERE id = ?6 AND (status = 'open' OR ?1 = 'ended')
   ```
   (a row that already says `ended` is never resurrected: `open` is written only
   over `open`), plus, when `revoked_org_id` is set,
   ```sql
   UPDATE rc_rooms SET org_id = NULL, workspace_id = NULL WHERE id = ?1 AND org_id = ?2
   ```
   bound to `(room_id, revoked_org_id)` — only over the scope that was revoked,
   never over one the owner has set since;
4. on success: `UPDATE room_state SET d1_pending = 0, d1_retry_at = NULL,
   d1_attempts = 0, revoked_org_id = NULL`;
5. on failure: `attempts = d1_attempts + 1`; `delay = min(30 000 × 2^(attempts −
   1), 1 800 000)`; `UPDATE room_state SET d1_attempts = ?, d1_retry_at = now +
   delay`; `console.error` a `rc_directory_write_failed` line. The alarm retries
   at `d1_retry_at`.

`markDirectoryDirty()` sets `d1_pending = 1, d1_retry_at = now, d1_attempts = 0`.
It is called when the host connects (not on a supersede), when the host leaves,
when the scope is revoked, and by `end()` (inside its transaction).

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`setScope`,
`applyOrgEvent`, `revokeScope`, `cutMember`, `flushDirectory`); the fan-out is
`apps/ingest/src/rc-revoke.ts`.

### 8.10 Alarm

One alarm serves every timed duty. `setAlarm` is called only when the computed
time differs from the current alarm, because each call is a row written.

**`rearm()`**: nothing when `room_id` is `NULL`. Otherwise the deadlines below
are collected and the alarm is set to `max(MIN(due), now)`; when the list is
empty the alarm is deleted.

While the room is **open**:

| deadline | when it applies |
| --- | --- |
| `host_first_hello_by` | until the first host hello |
| `connectedAt + 10 000` for every socket (either door) with `clientId === null` | the hello deadline |
| `min(now + 15 000, current alarm if still in the future)` | while a host is connected — the silence sweep; an alarm already due sooner is kept, so a busy room rearming often cannot push the sweep out of reach |
| `owner_offline_at + offline_grace_ms` | while no host is connected and the owner is marked offline |
| `snapshotRequestedAt + 10 000` | while a snapshot request is outstanding **and** at least one socket is parked |
| `MIN(at) + 30 000` over `rc_commands WHERE status = 'pending'` | the relay timeout |
| `MIN(expires_at)` over `rc_control_requests WHERE status = 'pending'` | request expiry |
| `driver_lost_at + 30 000` | the driver-loss grace |
| `lastHeard + 120 000` for every client socket | the client silence sweep |
| `lagSince + 10 001` for every lagging client socket | the lag cut |

Whatever the status:

| deadline | when it applies |
| --- | --- |
| `purge_at` | when `status = 'ended'` |
| `d1_retry_at` | when `d1_pending = 1` |

**`alarm()`**, in order:

1. `room = readState()` (fresh from storage); `room_id === NULL` → return;
2. `status = 'ended'`, `purge_at` set and `now >= purge_at` → `purge()`; return;
3. if open: `host_first_hello_by` set, `now >= host_first_hello_by` and no host
   connected → `end("never_hosted", "system")`;
4. if open: every socket (either door) with `clientId === null` and `now −
   connectedAt >= 10 000` → close `1001 "no hello"`, `forget()`;
5. if still open: if a host is connected and `now − lastHeard(host) > 45 000` →
   close `1001 "silent"`, `forget()`, `hostGone("silent")`;
6. if still open: no host connected, `owner_offline_at` set and `now >=
   owner_offline_at + offline_grace_ms` → `end("owner_timeout", "system")`;
7. if still open:
   1. a snapshot request older than 10 000 ms → `snapshotRequestedAt = null`;
      every parked socket served best-effort;
   2. `expireCommands(now)`;
   3. `expireControlRequests(now)`;
   4. `driver_lost_at` set and `now >= driver_lost_at + 30 000` → `seatToOwner()`;
      audit `control_released` (`system`, `subject` the lost driver, `{ reason:
      "driver_lost" }`); log;
   5. every client socket: `now − lastHeard > 120 000` → close `1001 "silent"`,
      forget, roster dirty if it had helloed; else if lagging more than 10 000
      ms → `cutLagging`;
   6. ring dirty and `now − lastHostFrameAt >= 1 000` → `checkpointQuiet(now)`;
8. `flushDirectory()`;
9. `rearm()`.

**`purge()`** (retention is up; `7 days` after the end, or at once for
`erased`):

1. D1 first, one batch: `DELETE FROM rc_members WHERE room_id = ?1`; `DELETE FROM
   rc_rooms WHERE id = ?1`;
2. on failure: `UPDATE room_state SET purge_at = now + 30 000`; `console.error`
   a `rc_purge_failed` line; `rearm()`; return (the object tries again rather
   than leaving a row that names a room nothing serves);
3. log `rc_room_purged`;
4. `storage.deleteAlarm()` (`deleteAll` leaves the alarm alone, and nothing is
   due once the room is gone);
5. `storage.deleteAll()`;
6. `migrate()` and `room = readState()`: the object is blank, as if the room
   had never been; every request answers `404` from here on.

A room ended `erased` has `purge_at = ended_at`, so it purges on the very next
alarm tick.

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`rearm`, `alarm`, `purge`).

### 8.11 Audit

The table (created by v1):

| column | type | meaning |
| --- | --- | --- |
| `id` | INTEGER AUTOINCREMENT | row id |
| `at` | INTEGER | `Date.now()` at the write |
| `event` | TEXT | one of `RC_AUDIT_EVENTS` |
| `actor_id` | TEXT | the principal's id, or `system` |
| `actor_kind` | TEXT | the principal's kind (`user` / `guest` / `link`), or `system` |
| `subject_id` | TEXT nullable | the principal the event is about, when not the actor |
| `request_id` | TEXT nullable | the control request concerned |
| `command_id` | TEXT nullable | the command concerned |
| `driver_epoch` | INTEGER nullable | the epoch after a seat change |
| `detail` | TEXT | a JSON object of scalars (`string | number | boolean | null`) |

Every event the object writes, with its actor and `detail` keys:

| event | actor | subject / ids | detail |
| --- | --- | --- | --- |
| `room_created` | owner | — | `{ agent, memberTier, orgId, workspaceId }` |
| `scope_set` | owner | — | `{ orgId, workspaceId }` |
| `scope_revoked` | `system` | — | `{ reason: "owner_removed" \| "org_deleted", sockets }` |
| `member_revoked` | `system` | subject: the user | `{ sockets, reason: "member_removed" }` |
| `settings_changed` | owner | — | `{ memberTier: tier \| null, acceptRequests: boolean \| null, title: "changed" \| null }` |
| `host_refused` | the dialling principal | — | `{ clientId }` |
| `host_superseded` | owner | — | `{}` |
| `host_online` | owner | — | `{ wants: "snapshot" \| "nothing" }` |
| `host_offline` | owner | — | `{ reason: "close" \| "silent" }` |
| `resync` | owner | — | `{ as_of_seq }` |
| `command_relayed` | sender | `command_id`, `driver_epoch` | per kind: `submit` → `{ kind, excerpt }` (the first 140 code points of `content`); `answer_permission` → `{ kind, requestId, optionId }`; `answer_elicitation` → `{ kind, requestId }`; `set_mode` → `{ kind, modeId }`; `set_model` → `{ kind, modelId }`; `set_config_option` → `{ kind, key }`; `stop` → `{ kind }` |
| `command_refused` | sender | `command_id` | `{ kind, gate, side: "relay" }` (`gate` is the gate, or the code when no gate) |
| `command_result` | owner | `command_id` | `{ kind, ok, gate: gate \| null, code: code \| null }` |
| `command_timed_out` | `system` | subject: sender; `command_id` | `{ kind }` |
| `control_requested` | asker | `request_id` | `{ kind, tier }` |
| `control_granted` | owner (grant) / answerer (request) | subject: the new driver; `request_id` (request path); `driver_epoch` | `{ kind }` for a grant; `{ kind, via: "request" }` for an approved request |
| `control_declined` | answerer, or `system` | subject: asker; `request_id` | `{ reason }` — `"declined"`, `"access_revoked"`, `"left"`, `"kicked"` |
| `control_timed_out` | `system` | subject: asker; `request_id` | `{}` |
| `control_released` | driver, or `system` | subject (system only): the lost driver; `driver_epoch` | `{ reason: "released" \| "driver_lost" }` |
| `taken_over` | owner | subject: previous driver; `driver_epoch` | `{}` |
| `driver_kicked` | owner | subject: target; `driver_epoch` | `{ sockets }` |
| `visitor_kicked` | owner | subject: target | `{ sockets }` |
| `room_closed` | owner, or the admin | — | `{ reason: "closed_by_owner" \| "closed_by_admin" }`, plus `admin: true` when the close came with the admin header |
| `room_ended` | `system`, or the eraser | — | `{ reason: "owner_timeout" \| "never_hosted" \| "erased" }`, plus `admin: true` for an erasure |

Events in `RC_AUDIT_EVENTS` that this object never writes today (reserved for
the invite and link doors): `link_created`, `link_revoked`, `password_set`,
`password_cleared`, `password_locked`, `invite_sent`, `invite_removed`,
`member_joined`, `link_visitor_revoked`.

Never recorded: a stream frame or its payload, a snapshot, an ack, a
slow-viewer cut, a ping, the host secret or its hash, a token, a link slug, a
full prompt (only the 140-code-point excerpt), an elicitation answer or a config
value, a room title (only `"changed"`).

*Reference implementation:* `apps/ingest/src/rc-do.ts` (`audit`, `commandDetail`).

### 8.12 Limits header

The socket doors read the feature catalogue once, at the dial, and stamp the
result on the upgrade request as `X-Atlas-Rc-Limits`, a JSON object with
exactly the six keys, each a number:

```json
{ "rc_rooms": 3, "rc_participants": 12, "rc_links": 5, "rc_tail_bytes": 2097152, "rc_offline_grace_ms": 3600000, "rc_command_burst": 10 }
```

How the door computes it:

- **the owner**, on either socket: the account's limits — the catalogue
  defaults for `rc.enabled` (`ACCOUNT_LIMITS`), gated by the platform switch
  alone;
- **an invited member**: the account defaults with the scope Organisation's
  `rc_participants` and `rc_links` in their place (`memberLimits(org)`) — the
  Organisation governs how many of its people a room may hold, never the
  owner's own ceilings; gated by the platform switch **and** the Organisation's
  `rc.enabled` grant.

The object's `parseLimits(header)`: `null` header → `null`; JSON that does not
parse → `null`; any of the six keys missing or not a number → `null`; else the
object as-is. A `null` answers the upgrade `403 rc_refused "remote control is
turned off"`. The parsed limits are stored on the socket's attachment and kept
for its life, whatever Ops changes meanwhile.

Which limit governs what, and where it is read:

| limit | read by | governs |
| --- | --- | --- |
| `rc_rooms` | the create door (D1 count of the owner's open rooms) | `409 limit_reached` on create; never read by the object |
| `rc_participants` | nobody today | reserved for the invite door |
| `rc_links` | nobody today | reserved for the link door |
| `rc_tail_bytes` | `/init` → `room_state.tail_limit` | the ring's byte cap, the "half the ring" checkpoint-snapshot trigger |
| `rc_offline_grace_ms` | `/init` → `room_state.offline_grace_ms` | how long the room stays open after the host leaves |
| `rc_command_burst` | the socket's attachment → `bucketFor` | the burst of the principal's command bucket (refill 2/s) |

The create door passes the owner's limits in `RcInit.limits`; the room keeps
the `rc_tail_bytes` and `rc_offline_grace_ms` it was created under for its whole
life.

*Reference implementation:* `apps/ingest/src/rc.ts` (`platformAccess`,
`orgAccess`, `memberLimits`, `serveRcSocket`); `apps/ingest/src/rc-do.ts`
(`parseLimits`).

## 9. The host's side of the protocol (what the desktop sends and expects)

The desktop runs one supervisor task per room in `crates/atlas-remote-control`.
Everything below is what the object must be ready for; where the host and the
object disagree the object is the authority and the host is what it is built
against.

**Dial.** `GET {ws_base}/rc/host/ws?room={roomId}` — the room id and nothing
else in the query; no `?org=`. The handshake is the artifacts one: subprotocol
offer `atlas.v1, atlas.ticket.<jwt>` with a freshly minted ticket; the `101`
must echo `atlas.v1` alone. Dial timeout 20 s. The ticket proves the account;
the secret, sent in the hello, proves the desktop.

| handshake status | the host does |
| --- | --- |
| `401` | re-mints the ticket once and redials at once; a second `401` goes Offline with "sign-in was refused" |
| `403` | stops for good: "remote control is turned off" |
| `404` | stops for good: "the room no longer exists" |
| `409` | stops for good (the room ended) |
| any other | redials on the backoff |

**Hello.** The first frame on every attempt — the secret is sent on **every**
hello, not only the first:

```json
{ "t": "rc.hello", "protocol": 1, "role": "host", "clientId": "<replica id>",
  "hostSecret": "<64 hex>", "as_of_seq": <n>,
  "capabilities": ["steer", "approve", "mode", "model", "config"],
  "agent": "<agent id>", "model": "<model id or null>" }
```

`as_of_seq` is: the `as_of_seq` of a snapshot the host took **before** dialling
(it does so when it has never synced, when its queue overflowed, or when it
knows it lost an envelope); otherwise the newest seq it has sent the room
(`floor`); otherwise `0`.

**Welcome.** The host waits up to 20 s (the dial window) for `rc.welcome { role:
"host" }`; a `rc.refused` or `rc.error` before it is remembered as the error
text for the close that follows. From the welcome it takes `driverEpoch`,
`driver`, and the scope (`orgId`/`workspaceId`, both read with a default so a
welcome missing them still parses). Then:

1. if it pre-took a snapshot: when `wants === "snapshot"` or the snapshot's
   `as_of_seq !== head`, it sends `rc.resync { as_of_seq }` followed by the
   snapshot parts; otherwise the room already holds exactly that much and
   nothing is sent;
2. if it did not and `wants === "snapshot"`: it takes a snapshot now (20 s
   deadline) and sends `rc.resync` plus the parts;
3. every control frame queued by the app before this attempt went live is
   **dropped** (a take-over sent across a reconnect would answer a seat that may
   have changed);
4. status becomes Live; `owner_online = true`.

**Streaming.** Envelopes arrive from a lossless tap into a bounded queue of
8 192 (`QUEUE_CAPACITY`). An envelope `≤` the covered seq is dropped (already in
a snapshot or sent); one that is not exactly `covered + 1` marks a gap, and so
does an envelope that cannot be serialised or that would not fit a frame alone
(past 262 144 bytes with its header). Envelopes are redacted
(`atlas_redact::redact_json`) and coalesced into kind-1 batches flushed every
33 ms or at 8 KiB of payload, whichever first, with an immediate flush for any
delta that is not streamed text; a batch never exceeds the frame cap. A queue
overflow sets an `overflowed` flag and the next thing the room hears is a
resync.

**Resync** (overflow, gap, unserialisable or too-large envelope, or an
`rc.refused` with code `snapshot_required` or `seq_regressed`): the pending batch
is cleared, the queue drained, a snapshot taken, then `rc.resync { as_of_seq }`
and the snapshot parts are sent; `floor` becomes `as_of_seq`. The object's
behaviour on `rc.resync` is §8.5.

**Snapshot requests.** On `rc.snapshot_request { reason }` the host flushes its
pending batch first (so the snapshot covers everything sent), takes a snapshot,
and sends the parts — no `rc.resync`; the room keeps its tail. A snapshot is the
desktop's `SessionSnapshot` JSON, redacted and fitted under 1 048 576 bytes
(the expendable fields `subagents` and `queue` emptied first, then the oldest
`messages` dropped with `rc_trimmed_messages` counting them; `available_commands`
and `config_options` go only in the last resort); it is cut into kind-2 frames
of at most 262 125 payload bytes, `flags = 0x01` on every part but the last,
`seq_first = as_of_seq`, `count = 1`. A snapshot that takes longer than 20 s is
abandoned and the attempt retried.

**Relayed commands.** On `rc.command { commandId, driverEpoch, from, command }`:

1. the `(from.id, commandId)` pair is checked against the last 256 pairs; a
   repeat is ignored (no result is sent — the object answers resends from its
   own record);
2. the desktop's gate, in order, each refusal producing an `rc.command_result`
   with `ok: false`, `refusedBy: "desktop"`, `gate`, `code`, `message`:
   1. `driverEpoch !== <epoch from the last welcome/roster>` → gate
      `epoch_stale`, code `epoch_stale`, "the driver changed; the epoch is <n>";
   2. `from.kind !== "user"` and the kind needs `steer_approve` or is
      members-only → gate `tier`, code `members_only`, "only a signed-in member
      may <kind>";
   3. seat: `stop` passes for the owner or the driver; everything else passes
      only for the driver. The owner refused → gate `not_driver`, code
      `not_driver`, "someone else is driving; take over to steer"; anyone else
      → gate `not_driver`, code `not_driver`, "only the driver may steer";
   4. the kind's capability (`submit`/`stop` → `steer`; `answer_*` → `approve`;
      `set_mode` → `mode`; `set_model` → `model`; `set_config_option` →
      `config`) not advertised → gate `tier`, code `capability`, "this desktop
      does not take <kind> from a remote";
   5. `set_mode` whose `modeId` contains (case-insensitively) any of `bypass`,
      `full`, `yolo`, `danger`, `unrestricted`, `auto`, `trust`, `skip`,
      `unsafe`, `always` → gate `widening`, code `widening`, "that mode lets the
      agent act without asking; choose it on the desktop" — **for every remote
      origin, the owner included**;
   6. `set_config_option` from a non-owner whose `key` contains any of
      `permission`, `approve`, `approval`, `sandbox`, `bypass`, `network`,
      `trust`, `yolo`, `danger` → gate `widening`, code `widening`, "only the
      owner may change this session's options";
   7. size: `submit.content` over 32 768 bytes → gate `tier`, code
      `payload_too_large`, "a prompt is at most 32768 bytes"; blank content →
      gate `tier`, code `empty`, "a prompt needs some text"; an
      `answer_elicitation.answer` or `set_config_option.value` over 8 192 bytes
      serialised → gate `tier`, code `payload_too_large`, "a value is at most
      8192 bytes serialised";
3. the app's own layer then refuses a standing permission grant
   (`AllowAlways`/`RejectAlways` options) from **any** remote surface, the
   owner included (gate `widening`, "a grant for the rest of the session is
   made on the desktop, not from a remote"); a permission option the agent did
   not offer (gate `option_standing`, code `option_standing`); a prompt that is
   not pending on this session (gate `not_pending`, code `not_pending`); a
   non-owner setting a config option outside the `thought_level`, `model_config`
   and `model` categories; and maps any other steering error to gate
   `in_flight` with code `in_flight` (a turn is running, the queue is full, the
   mode cannot change mid-turn) or `agent_error`;
4. the command runs on its own task with a 25 000 ms deadline
   (`RC_COMMAND_TIMEOUT_MS − 5 000`, inside the object's 30 s). Accepted →
   `{ "t": "rc.command_result", "commandId", "fromId": <from.id>, "ok": true }`;
   refused → the shape of §8.6 with `refusedBy: "desktop"`, `code` cut to 64
   characters and `message` (redacted) to 500; the deadline passing → gate
   `in_flight`, code `desktop_timeout`, "the desktop is still working on it".

Results are sent on the live socket as they come; a result produced while the
socket is down is sent on the next live attempt (the object ignores one for a
command it has already timed out).

**Master frames the host sends** (only while Live; refused locally otherwise):
`rc.take_over`, `rc.control_answer { requestId, approve }`, `rc.grant_control {
target }`, `rc.kick { target }`. It never sends `rc.request_control`,
`rc.release_control`, `rc.ack` or a client hello. It sends `rc.close` through
the REST close door rather than the socket (the app calls `POST
/rc/rooms/{id}/close`; the task's `stop()` only closes the socket politely).

**Keepalive.** A text frame `ping` every 15 000 ms; `pong` is ignored on
receipt. If nothing (any frame, `pong` included) has arrived for 45 000 ms the
host drops the socket itself and redials ("the room went quiet").

**Close codes**, what the host derives:

| close code | the host does |
| --- | --- |
| `1008` | Ended: "access to this room was revoked"; stops |
| `4410` | Ended (reason from the `rc.closed` that preceded it); stops |
| `4409` | Superseded: this task stops, Offline with "another connection from this desktop took over"; no redial |
| `4403` | Ended: "the room did not accept this desktop as its host"; stops |
| `4400` | Ended: "the room speaks another protocol version; update Atlas"; stops |
| `1001`, `1013`, any other, or none | redials on the backoff |

**Redial backoff.** `random(0.5, 1.5) × min(1 s × 2^attempt, 30 s)`; `attempt`
resets to 0 after any attempt that reached a welcome, and on a nudge (a wake or
a network change), which also redials at once.

**What each server frame does to the host's status** (`HostStatus`: `state`,
`owner_online`, `viewers`, `driver_epoch`, `driver`, `pending`, `scope`,
`last_error`, `end_reason`):

| frame | effect |
| --- | --- |
| `rc.welcome` (host) | `state = live`, `owner_online = true`, `driver_epoch`, `driver`, `scope` set, `last_error` cleared |
| `rc.roster { scope: "full" }` | `driver_epoch`, `owner_online`, `driver` taken; `viewers` = distinct `peers[].id` |
| `rc.control_request { request }` | the request replaces any with the same id in `pending`; kept only while `status === "pending"`; entries whose `expiresAt <= now` are pruned on every status report |
| `rc.snapshot_request` | a snapshot is sent (above) |
| `rc.command` | gated and run (above) |
| `rc.closed { reason }` | `state = ended`, `end_reason = reason`; the task stops |
| `rc.refused { code, message }` | `last_error = message` (a `payload_too_large` is reworded as a snapshot failure); `snapshot_required` and `seq_regressed` also schedule a resync |
| `rc.error { message }` | `last_error = message` |
| `rc.synced`, `rc.owner`, `rc.resync`, `rc.command_result`, client welcomes | ignored (for clients) |
| an unknown `t` | ignored — a new server frame must not take the socket down |

The host-side constants transcribed from the contract and held equal by its
contract test: `RC_PROTOCOL_VERSION 1`, `RC_SOCKETS_MAX 64`,
`RC_SOCKETS_PER_PRINCIPAL 4`, `RC_DELTA_MAX_BYTES 262144`,
`RC_FRAME_HEADER_MAX_BYTES 19`, `RC_SNAPSHOT_PART_MAX_BYTES 262125`,
`RC_SNAPSHOT_MAX_BYTES 1048576`, `RC_HOST_PING_MS 15000`, `RC_HOST_SILENT_MS
45000`, `RC_CLIENT_PING_MS 25000`, `RC_COALESCE_MS 33`, `RC_COALESCE_BYTES 8192`,
`RC_COMMAND_TIMEOUT_MS 30000`, `RC_PROMPT_MAX 32768`,
`RC_COMMAND_FRAME_MAX_BYTES 36864`, `RC_COMMAND_VALUE_MAX_BYTES 8192`,
`RC_CONTROL_MAX_BYTES 4096`, `RC_REHELLO_MAX 3`, `RC_HELLO_TIMEOUT_MS 10000`,
`RC_KICK_MS 600000`, `RC_CONTROL_REQUEST_TIMEOUT_MS 60000`,
`RC_CONTROL_COOLDOWN_MS 30000`, `RC_VIEWER_LAG_BYTES 2097152`,
`RC_VIEWER_LAG_MS 10000`, and the widening-mode word list in order.

*Reference implementation:* `crates/atlas-remote-control/src/host.rs`,
`gate.rs`, `wire.rs`, `codec.rs`, `snapshot.rs`; the app layer is
`src-tauri/src/commands/rc.rs`.

## 10. Acceptance tests

Every suite below passes on the reference branch. A test's name is its
acceptance criterion; the suite file is the harness. Static `it(...)` sites
are counted per file; a templated `it` inside a loop or `it.each` expands at
run time as stated.

### 10.1 The shared harness (`apps/ingest/test/rc-client.ts`)

Runs under `@cloudflare/vitest-pool-workers` with the ingest worker as `SELF`
and the real `RC_DO` and `ROUTING_DB` bindings. The helpers:

| helper | does |
| --- | --- |
| `DESKTOP` | the owner's replica id, `"desk-0001-owner"` |
| `grantRc(org, limits?, enabled = true)` | upserts `org_feature_overrides (org_id, 'rc.enabled', enabled, limits_json, …)` |
| `globalRc(enabled)` | upserts `platform_feature_flags ('rc.enabled', enabled, …)` — the kill switch |
| `rcOrg(limits?)` | a fresh Organisation id with the grant |
| `tokenFor(org, user, role = "developer")` | a signed token for `user` naming `{ [org]: role }`, or `orgs: {}` when `org` is `null` |
| `rcDoor(org, user, path, init?, role?)` | `call("/rc" + path, { token })` |
| `createRoom(org, user = "owner", body?, role?)` | `POST /rc/rooms` with `scope` (`{ orgId: org, workspaceId: null }` or `null`), a random `sessionId`, `clientId: DESKTOP`, `agent: "atlas-agent"`, `model: "claude-opus-5"`, `title`, all five capabilities; `body` overrides |
| `newRoom(org, body?)` | `createRoom` asserted `201`, returning `{ room, hostSecret }` |
| `invite(roomId, user)` | writes the `rc_members` row the invite door will write |
| `rcUpgrade(path, query, protocols)` | `SELF.fetch` with `Upgrade: websocket` and the offer |
| `openSocket(room, user, door = "member", org = null, role?)` | dials `/rc/host/ws` or `/rc/ws` `?room=` with a ticket; throws unless `101`; returns an `RcClient` whose every received text frame is parsed with `RcServerControl` (a frame outside the contract fails the test), binary frames decoded in arrival order, `autoAck(on)` acking each binary frame's last seq, `awaitControl(p, ms = 3000)`, `awaitBinary`, `sendJson`, `sendBinary`, `sendText`, `closed` (a promise of the close code), `close()` |
| `frame(client, t, p?, ms?)` | await the next control frame of type `t` matching `p` |
| `openHost(room, secret, { asOf = 0, clientId = DESKTOP, user = "owner" })` | `openSocket(…, "host")`, `hostHello`, await `rc.welcome` |
| `hostHello(secret, asOf = 0, clientId = DESKTOP)` | `{ t: "rc.hello", protocol: 1, role: "host", clientId, hostSecret?, as_of_seq, capabilities: [all five], agent: "atlas-agent", model: "claude-opus-5" }`; `hostSecret` omitted when `secret` is `undefined` |
| `clientHello(clientId, since = 0, surface = "web")` | `{ t: "rc.hello", protocol: 1, role: "client", clientId, since, surface }` |
| `freshClientId(user)` | `c-<user>-<n>`, 8–64 chars |
| `join(room, user, since = 0, clientId?)` | `openSocket`, `clientHello`, await `rc.welcome` then `rc.synced`; returns `{ client, clientId, welcome, synced }` |
| `envelope(seq, pad = 0)` | the UTF-8 of `{"agent_id":"atlas-agent","session_id":"ses_01","seq":<seq>,"kind":"text_chunk","message_id":"m1","delta":"x"×pad}` |
| `deltas(seqFirst, count = 1, pad = 0)` | a kind-1 batch of `count` envelopes from `seqFirst` (`encodeRcDeltaBatch`) |
| `snapshotFrames(asOf, bytes, part = 262125)` | kind-2 parts, `flags 0x01` on all but the last |
| `snapshotBytes(size, fill = 0x7b)` | a filled buffer |
| `receivedSnapshot(client)` | the concatenated payloads of every kind-2 frame received |
| `command(commandId, cmd = { kind: "stop" }, driverEpoch = 1)` | `{ t: "rc.command", commandId, driverEpoch, command }` |
| `commandId()` | `01JC` + a 22-digit counter — ULID-shaped, unique per run |
| `roomObject(room)` | the stub via `rcDoName` |
| `inRoom(room, sql, …bindings)` | runs SQL inside the object (to age a timestamp, never to assert) |
| `rows(room, sql, …)` | rows from the object's SQLite |
| `stored(room)` | every table's rows as one JSON string (for "storage unchanged" assertions) |
| `inMemory(room, fn)` | reach into the instance (to age an in-memory clock) |
| `ageSockets(room, ms, which = "all")` | pushes `lastHeardAt`, `connectedAt`, `helloAt` (and `lastHostFrameAt`) back by `ms` |
| `until(check, ms = 3000)`, `sleep(ms)` | polling helpers |
| `endRooms()` | marks every open `rc_rooms` row ended and deletes its members (the per-account rooms limit would otherwise be hit by the fourth test); every suite calls it `afterEach` |
| `roomRow(roomId)`, `memberRows(roomId)` | the directory row; the member user ids |

Alarms are driven with `runDurableObjectAlarm(roomObject(room))` after ageing
the relevant timestamp with `inRoom`/`inMemory`.

### 10.2 `apps/ingest/test/rc-arbitration.test.ts` (9)

**asking for the seat**
- [ ] reaches the desktop, the owner's phone and the asker as one pending request; asking again is the same request, not a second
- [ ] is refused by tier, to the owner, to the driver, when the room takes no requests, and while the desktop is offline

**answering**
- [ ] approve from the desktop: the asker drives under a new epoch — the desktop's roster first — and the owner is not_driver with the way back
- [ ] decline from the owner's phone: the asker is told, the owner still drives, and asking again waits out the cooldown
- [ ] only the owner or the driver answers; an unknown id is request_unknown
- [ ] approve for an asker whose tier no longer steers declines access_revoked

**a request's life**
- [ ] times out on the alarm: the desktop and the asker hear timed_out, and the id is then unknown
- [ ] is cancelled when the asker is kicked, or when their last socket goes, and the desktop is told why
- [ ] is shown to whoever arrives late: the desktop as frames after its welcome, the owner's phone and the asker in welcome.pending, nobody else

### 10.3 `apps/ingest/test/rc-backpressure.test.ts` (8)

**acks**
- [ ] move what the object counts as in flight to a viewer

**a lagging viewer**
- [ ] is told and cut 1013 after 2 MiB and 10 s behind, without holding up anyone else — and the host never is
- [ ] gets nothing more while it lags, and the frames it missed from the ring once it acks its way back
- [ ] is not cut while it keeps up

**the in-flight budget**
- [ ] serves a 1 MiB snapshot to a full room in waves: 16 MiB at a time, the rest once acks come back

**socket caps**
- [ ] close a socket on either door that has not said hello by the deadline, however it pings
- [ ] count a socket toward the room cap from the moment it connects, hello or not
- [ ] refuse a principal's fifth socket with room_full and 1013

### 10.4 `apps/ingest/test/rc-commands.test.ts` (25)

**the owner's commands**
- [ ] reach the host with who sent them, and the host's answer comes back to the sender
- [ ] are sent to the host before the row is written
- [ ] carry the desktop's refusal back with its gate and code
- [ ] may set a config option, but not a value over 8 KiB
- [ ] refuse a prompt over 32 KiB, and a frame too large to read
- [ ] issued under a stale epoch are refused

**who may steer**
- [ ] refuses a view-tier member by tier, and a steer-tier member who is not the driver

**idempotency**
- [ ] answers a resend from the record and never relays it twice
- [ ] keys on the sender too: another principal's reuse of an id is its own command, never the first one's answer
- [ ] ignores a result for a command it never relayed

**rates and timeouts**
- [ ] drops a principal's commands past its burst — the account's, not the Organisation's — by rc.refused rather than a queue
- [ ] answers relay_timeout when the host is silent 30 s after a relay — on the alarm

**an absent owner**
- [ ] fails a command at once, and nothing is delivered when the desktop comes back

**the command path**
- [ ] reads no D1

**one driver**
- [ ] the owner hands the seat to a member: the epoch advances and everyone learns it from the roster
- [ ] while a member drives, the owner cannot submit — from the phone or any surface — and is told to take over
- [ ] the owner keeps `stop` while somebody else drives: the master's kill switch is never seat-gated
- [ ] the owner takes the seat back: the epoch advances, the owner steers again and the member is refused
- [ ] every one of the owner's own devices sends while the owner holds the seat
- [ ] only the owner may grant, and only to somebody in the room whose tier allows steering
- [ ] the driver hands the seat back, and a kicked driver loses it
- [ ] a kick is sticky: the kicked redial is refused for RC_KICK_MS, then admitted again; the invite stands
- [ ] a driver whose last socket closes is `lost` for a grace, then the seat returns to the owner on the alarm
- [ ] a lost driver who returns inside the grace keeps the seat
- [ ] lowering the member tier below steer takes the seat from a member driving on it

### 10.5 `apps/ingest/test/rc-features.test.ts` (8)

**GET /rc/features**
- [ ] answers the platform switch and the account's defaults to a token naming no Organisation
- [ ] with ?org=, says whether that Organisation's members may be invited, and its limits where granted
- [ ] answers an Organisation the caller is not in as one that can invite nobody, never a refusal

**the start doors**
- [ ] open a solo room under the platform switch alone, and refuse one by the layer that said no
- [ ] refuse the owner's dials once the platform switch is off, a member's once the grant is, and close nothing already open
- [ ] refuse a room past the account's open-rooms limit with 409 naming the figure

**a socket's limits**
- [ ] are the account's, kept as it connected under them, whatever Ops changes meanwhile
- [ ] a member's carry the scope Organisation's capacity, and the account's everything else

### 10.6 `apps/ingest/test/rc-host.test.ts` (17)

**who may host**
- [ ] admits the owner's desktop that presents the secret, and welcomes it
- [ ] refuses the owner's own token and replica id with a wrong or missing secret — and the real host stays
- [ ] refuses the right secret from another replica id
- [ ] answers 404 to anybody but the owner on the host door, an invited member included
- [ ] needs no Organisation on the dial: the owner's ticket with `orgs: {}` hosts a scoped room, and `?org=` is not read
- [ ] lets a second socket that presents the secret supersede the first with 4409
- [ ] refuses a stream frame, a resync or a command result from a client socket, and relays none of them

**the stream**
- [ ] relays a frame byte for byte, and a batch of three advances the head by three
- [ ] drops a frame whose seq does not move forward, and tells the host
- [ ] relays across a gap, and asks the host for a snapshot
- [ ] refuses an unreadable header, an unknown kind, a zero count and an oversized frame

**resync and snapshots**
- [ ] on a host resync: clients are told, deltas wait for the snapshot, and the snapshot arrives whole
- [ ] refuses a snapshot past 1 MiB reassembled

**a desktop that goes quiet**
- [ ] is offline once silent 45 s, found by the +15 s sweep
- [ ] is not offline while it pings, however long since its last delta

**a host's other frames**
- [ ] closes the room from the desktop
- [ ] answers a hello in the wrong protocol with an error and 4400

### 10.7 `apps/ingest/test/rc-join.test.ts` (10)

**a joiner from nothing**
- [ ] gets the snapshot, then the frames past it — batches intact, byte for byte — then synced, then the roster
- [ ] is served from the ring alone when the room holds the session from its first seq

**a joiner that reconnects**
- [ ] within the tail gets only the frames whose last seq is past its own, with no snapshot
- [ ] ahead of the room is told to start over, and may say hello again
- [ ] may say hello again only three times a minute: the fourth is refused and closed 1001
- [ ] is refused a second hello on a socket that was not told to start over

**a joiner the room cannot serve yet**
- [ ] waits for the desktop's snapshot, then gets it and the frames past it
- [ ] is answered after 10 s regardless: synced with what the room holds, and snapshot_unavailable
- [ ] with the owner offline, does not wait at all

**presence**
- [ ] is derived from open sockets and never stored: the object's SQLite is identical across joins and leaves

### 10.8 `apps/ingest/test/rc-offline.test.ts` (4)

**the desktop leaving**
- [ ] tells every viewer at once, with when the room ends — the grace the room was created under
- [ ] ends the room owner_timeout when the grace runs out, on the alarm

**the desktop coming back**
- [ ] in grace with nothing new is welcomed back and viewers are told it is online
- [ ] ahead of the room is asked for a snapshot; viewers are resynced from it and apply no seq twice

### 10.9 `apps/ingest/test/rc-retention.test.ts` (3)

**retention**
- [ ] keeps an ended room's audit for RC_ROOM_RETENTION_MS, then the alarm purges the object and the directory rows

**erasure**
- [ ] ends the rooms on an erased Session `erased` — only those scoped to that Workspace — and purges them on the next alarm
- [ ] is idempotent: erasing again finds no open room, and a room ended `erased` by hand purges at once

### 10.10 `apps/ingest/test/rc-rooms.test.ts` (26)

**creating a room**
- [ ] answers 201 with the room and a 64-hex host secret, owned by the caller, driven by them at epoch 1
- [ ] is idempotent per Session: a repeat answers 200, the same room, and never the secret again
- [ ] needs no Organisation: a token with `orgs: {}` creates, hosts, lists, reads, steers and closes its own solo room
- [ ] ignores a stale or foreign ?org=: the room is created solo and the pin is never an error
- [ ] takes a scope only the caller may give — their own granted Organisation, a Workspace they can read — and makes no room otherwise
- [ ] is idempotent per owner and Session whatever Organisation the desktop is pinned to meanwhile
- [ ] refuses a malformed /init at the object: parsed, never cast
- [ ] counts the open-rooms limit per account, across Organisations and none

**a room's scope**
- [ ] is set once: a solo room takes a scope by PATCH, and neither room takes a second
- [ ] is revoked when the owner leaves the Organisation: members are cut and forgotten, the room continues solo
- [ ] is revoked when the Organisation is deleted, and a removed member is cut from the rooms scoped to it
- [ ] is set in the directory first, and put back when the object cannot take it, so the next PATCH is a retry
- [ ] is revoked on the redelivery when the object refused the first time: the row still names the Organisation until the object has heard

**reading and listing**
- [ ] shows a room to its owner and its invited members, and 404s everyone else — an uninvited admin included
- [ ] says whether the desktop is online, from the object
- [ ] lists the caller's own rooms and the ones they were invited to, open first, without waking any
- [ ] lists across every Organisation and none, with the desktop's dot from the directory; ?org= only filters

**changing a room**
- [ ] lets only its owner change it; an invited member is told so, anyone else sees nothing
- [ ] re-badges a member's open socket in place and sends everyone the roster
- [ ] refuses an unknown field, an empty change, and any change to an ended room

**closing a room**
- [ ] ends it for its owner: every socket is told and closed 4410, and the row says so
- [ ] lets an admin of the scope Organisation close a room they may not watch, and says who did; a solo room has no admin
- [ ] refuses an invited member
- [ ] is held to owner-or-admin by the object itself, not the door alone; an admin's close is recorded as one
- [ ] ends a room whose desktop never said hello, on the alarm, as never_hosted
- [ ] frees its place under the account's open-rooms limit

### 10.11 `apps/ingest/test/rc-tail.test.ts` (7)

**the ring**
- [ ] is not written per frame: the object's SQLite is unchanged across 1,000 relayed frames
- [ ] is checkpointed once the stream goes quiet, in a row or three — never a row per frame
- [ ] is checkpointed at least every 30 s while the stream never pauses
- [ ] comes back from storage after the object is evicted, and serves a joiner the same bytes

**eviction**
- [ ] never strands the joiner path: past the cap it asks for a snapshot first, and evicts once it is in
- [ ] asks for a checkpoint snapshot when the stream goes quiet after half the ring's worth of new bytes
- [ ] does not ask when little has streamed

### 10.12 `apps/ingest/test/rc-wire.test.ts` (15 sites; 64 at run time)

**the binary batch header**
- [ ] `round-trips: <fixture.name>` — one per entry of `RC_WIRE_FIXTURES` (6): `delta, count 1`; `delta batch, count 3, one envelope over 127 bytes`; `delta, multi-byte seq`; `delta, seq past 2^32`; `snapshot as of 4, part 1 of 2 (more)`; `snapshot as of 4, part 2 of 2`
- [ ] covers a single delta, a batch of three and a snapshot in two parts
- [ ] keeps the JSON fixture file the desktop reads identical to the contract
- [ ] rejects a truncated header rather than guessing
- [ ] stops a varint at 8 bytes, and past the safe-integer range
- [ ] names a frame the protocol does not carry: version, kind, a zero count, a snapshot part of more than one
- [ ] refuses a batch whose lengths do not account for its payload
- [ ] refuses to encode a number it cannot carry

**control frames**
- [ ] keeps the JSON fixture file the desktop reads identical to the contract
- [ ] names the widening mode words the desktop's gate transcribes, in order
- [ ] `parses, to the object: <fixture.name>` — one per entry of `RC_FRAME_FIXTURES.toServer` (21): `host hello`; `client hello`; `ack`; `host resync`; `command: submit`; `command: stop`; `command: answer_permission`; `command: answer_elicitation`; `command: set_mode`; `command: set_model`; `command: set_config_option`; `command result: accepted`; `command result: refused by the desktop`; `request control`; `control answer`; `release control`; `kick`; `take over`; `grant control`; `close`
- [ ] `parses, from the object: <fixture.name>` — one per entry of `RC_FRAME_FIXTURES.fromServer` (25): `host welcome`; `host welcome (solo room)`; `client welcome (member)`; `client welcome (link visitor)`; `synced`; `roster (full)`; `roster (guest)`; `owner offline`; `owner online`; `control request`; `command to the host`; `command result: ok`; `command result: pending (a resend)`; `command result: refused by the relay`; `command result: refused by the relay, the owner while somebody else drives`; `command result: refused by the desktop`; `command result: relay timeout`; `snapshot request`; `resync (host)`; `resync (ahead)`; `resync (lagging)`; `closed`; `refused`; `refused (cooldown)`; `error`
- [ ] has an example of every frame kind, both directions
- [ ] carries the closed enums both sides transcribe
- [ ] refuses a command that names its own sender, and a hello missing what it needs

### 10.13 `apps/web/src/lib/rc-proxy.test.ts` (22 sites; 49 at run time)

**path matching**
- [ ] claims the RC prefix and nothing adjacent to it

**the allow-list**
- [ ] `forwards <path> by <method>` — 19 cases: `/api/rc/features` GET; `/api/rc/invites` GET; `/api/rc/ws` GET; `/api/rc/rooms` GET; `<ROOM>` GET; `<ROOM>` PATCH; `<ROOM>/close` POST; `<ROOM>/audit` GET; `<ROOM>/members` GET; `<ROOM>/links` GET; `<ROOM>/links` POST; `<ROOM>/links/abc123` DELETE; `<ROOM>/links/abc123/password` PUT; `<ROOM>/links/abc123/password` DELETE; `<ROOM>/invites` POST; `<ROOM>/invites/user_2` DELETE; `/api/rc/public/links/slug1` GET; `/api/rc/public/links/slug1/unlock` POST; `/api/rc/public/links/slug1/ws` GET (`ROOM` = `/api/rc/rooms/01JB8Z5G7Q2W3E4R5T6Y7V8X9Z`)
- [ ] `refuses <path> by <method>` — 10 cases: `/api/rc/rooms` POST; `/api/rc/host/ws` GET; `/api/rc/features` POST; `<ROOM>` DELETE; `<ROOM>/close` GET; `<ROOM>/links/abc123` GET; `<ROOM>/nonsense` GET; `/api/rc/rooms/not-an-id!` GET; `/api/rc` GET; `/api/rc/public/shares/x` GET
- [ ] answers a refused door 404 without minting or reaching ingest

**the Origin check**
- [ ] refuses a state-changing request from another origin before minting
- [ ] refuses a socket upgrade from another origin before minting
- [ ] refuses a write or an upgrade that names no origin at all
- [ ] lets a plain read through without one
- [ ] lets a same-origin write through

**member requests**
- [ ] refuses without a session, minting nothing
- [ ] prepends /rc to the forwarded path and keeps the query
- [ ] mints and forwards with no ?org= at all: a room belongs to the account, so a person with no Organisation lists and dials theirs
- [ ] mints once however the page's ?org= changes: the token is the account's, and the query is only forwarded
- [ ] attaches a server-minted bearer to REST and overwrites one the page sent
- [ ] replaces the socket offer wholesale with atlas.v1 and the minted ticket
- [ ] scrubs the cookie, identity headers and every RC header the page sent

**the anonymous link door**
- [ ] forwards with no session and mints nothing
- [ ] gives a signed-in visitor no extra standing, and drops a bearer
- [ ] keeps the link's own RcLink credential
- [ ] rebuilds the socket offer to atlas.v1 and the one atlas.rc.* entry
- [ ] still checks the Origin on its writes and upgrades
- [ ] leaves everything outside /public/ behind the session

### 10.14 `apps/web/src/lib/use-rc-room.test.tsx` (21 sites; 23 at run time)

**useRcRoom**
- [ ] opens the member socket on this origin with the room alone — no org — offering atlas.v1 only, and says hello with nothing
- [ ] takes who it is, the driver and the owner from the socket
- [ ] draws the catch-up only once rc.synced says it is whole, then live frames as they land
- [ ] draws once per animation frame, however many socket frames landed in it
- [ ] draws by the 250 ms backstop when animation frames are paused
- [ ] holds the draw while the reader is mid-fling, for at most 400 ms
- [ ] on visibilitychange, draws what is pending and redials a closed socket at once, with since
- [ ] on online and pageshow, leaves an open socket alone
- [ ] acks the newest applied seq a second after frames arrive
- [ ] acks at once past 64 KiB
- [ ] starts over with since 0 on a gap the room could not fill
- [ ] hellos again from nothing when the room says it is ahead
- [ ] reconnects with since after an ordinary close, on a jittered backoff
- [ ] `stops reconnecting on <code>` — 3 cases: `1008` → `revoked`; `4410` → `ended`; `4403` → `forbidden`
- [ ] waits at least 30 s after room_full
- [ ] sends a command under a ULID and the driver epoch it last heard, and shows its answer
- [ ] says no answer, not refused, when the desktop timed out; and names the gate when it refused
- [ ] never queues a command while not welcomed
- [ ] records that the room ended
- [ ] pings every 25 s while open

**reconnectDelay**
- [ ] is jittered between half and one and a half of the capped backoff

### 10.15 `apps/web/src/features/rc/rc-controls.test.tsx` (15)

**controlBlock**
- [ ] walks the chain: seat, tier, members-only, then a list

**rows and consent**
- [ ] draws a widening mode disabled as Desktop only, for the owner too
- [ ] draws every widening word Desktop only — the newer ones too — and leaves an ordinary mode alone
- [ ] lets a member set thought_level, model_config and model options and nothing else; the owner anything
- [ ] words a refusal by gate and code
- [ ] writes the note a change with an origin earns

**useSettingCommand**
- [ ] holds the pick pending, and clears it on accepted
- [ ] reverts and shows the words on a refusal, and shows the send problem when it never left
- [ ] releases after the deadline with no answer
- [ ] lets a foreign model change win while pending

**SessionControls**
- [ ] renders the three triggers with resolved names, disabled with the reason when the seat is not this page’s
- [ ] hides Options for a link visitor and enables the rest for the driver
- [ ] picks optimistically: the trigger reads the picked value with a spinner until the room answers
- [ ] draws the widening mode row disabled in the sheet
- [ ] hides every control when the agent advertises nothing

### 10.16 `packages/do-protocol/test/upgrade.test.ts` (19)

**authorizeWsUpgrade**
- [ ] resolves the caller's id, org and role from a valid ticket (AC1)
- [ ] refuses a request that names no Organisation → 400 (AC4)
- [ ] refuses an absent ticket → 401 (AC4)
- [ ] refuses a malformed ticket → 401 (AC4)
- [ ] refuses an expired ticket → 401 (AC4)
- [ ] refuses a valid ticket for a different Organisation → 403 (AC4)

**authorizeWsUpgradeSubject**
- [ ] proves the account from a valid ticket and needs no Organisation: `orgs: {}` and no `?org=` pass
- [ ] ignores a `?org=` the ticket does not name: the door decides from its own rows
- [ ] refuses an absent, malformed or expired ticket → 401, like the org-scoped door
- [ ] leaves the org-scoped door as strict as it was: no `?org=` is still 400 there

**stampSubject**
- [ ] stamps the user and strikes any Organisation or role a caller sent

**stampIdentity**
- [ ] hands the DO the verified identity, and the DO reads back what was stamped
- [ ] overwrites identity headers a caller tried to set itself
- [ ] keeps the upgrade intact — the ticket subprotocol still rides along (AC5)

**acceptedUpgrade**
- [ ] echoes the base subprotocol on the 101 and nothing else (AC5)

**forwardWsUpgrade**
- [ ] resolves the instance name through the injected resolver (AC2)
- [ ] supports an async resolver, for the caller that reads a routing table (AC2)
- [ ] 404s an Organisation the resolver has no instance for
- [ ] never reaches the Durable Object when authorisation fails (AC4)

### 10.17 Commands that must pass, and the counts on the reference branch

Run from the server repository root with `pnpm@11.5.3` (the `packageManager`
pin; `corepack pnpm` resolves it).

| command | result on 2026-10-26 |
| --- | --- |
| `pnpm --filter @atlas/ingest typecheck` | exit 0 |
| `pnpm --filter @atlas/ingest test` | 49 files, 684 tests, all passing (the eleven `rc-*` files are 181 of them) |
| `pnpm --filter @atlas/web test` | 98 files, 1 055 tests, all passing (the three RC files are 87 of them) |
| `pnpm --filter @atlas/do-protocol test` | 1 file, 19 tests, all passing |

The contracts package has its own suite (`pnpm --filter @atlas/contracts
test`), which the fixture-equality tests in `rc-wire.test.ts` depend on; it
passes. The desktop holds `packages/contracts/fixtures/rc-wire-v1.json` and
`fixtures/rc-frames-v1.json` byte-identical to the server's through
`crates/atlas-remote-control/tests/contract.rs`; a change to either fixture
is a change to both repositories.

## 11. Operational notes

### 11.1 `apps/ingest/wrangler.jsonc`

The binding and the migration tag, verbatim; the two existing lines are shown
for position:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "WORKSPACE_DO", "class_name": "WorkspaceDurableObject" },
      { "name": "THREAD_DO", "class_name": "SharedThreadDurableObject" },
      { "name": "RC_DO", "class_name": "RcRoomDurableObject" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["WorkspaceDurableObject"] },
    { "tag": "v2", "new_sqlite_classes": ["SharedThreadDurableObject"] },
    { "tag": "v3", "new_sqlite_classes": ["RcRoomDurableObject"] }
  ],
```

`RcRoomDurableObject` is a **SQLite-backed** class (`new_sqlite_classes`, not
`new_classes`): the schema in §8.2 needs `ctx.storage.sql`, and the
hibernation API needs the class to extend `DurableObject` from
`cloudflare:workers`. The class is exported from the worker's entry
(`export { RcRoomDurableObject } from "./rc-do"` in `apps/ingest/src/index.ts`).
Nothing is provisioned by hand: `wrangler deploy` brings the class up from the
migrations block.

The object's `env` type needs only `ROUTING_DB` (the `atlas-auth` D1 database,
bound as today). The doors need `RC_DO`, `ROUTING_DB`, `RATE_LIMIT`, the JWKS
verification environment, the registry environment and the Turnstile pair
(`TURNSTILE_SITE_KEY` var, `TURNSTILE_SECRET` secret, already bound; read only
by `GET /rc/features` today).

### 11.2 Queue consumers touched

The ingest worker already consumes `atlas-artifact-events` (membership and
role changes published by `atlas-auth`; `max_batch_size 10`, `max_retries 5`,
dead-letter `atlas-artifact-events-dlq`). The consumer's `tellEveryObject`
gains a third fan-out after the Workspace objects and the Shared Threads:
`tellEveryRcRoom(env, event)`, which

1. selects the open rooms with `rc_rooms.org_id = event.org_id`; none → 0;
2. for `org.deleted`: `DELETE FROM rc_members WHERE room_id IN (SELECT id FROM
   rc_rooms WHERE org_id = ?1 AND status = 'open')`; for `member.removed`: one
   batch deleting the user's `rc_members` rows in the Organisation's open rooms
   and every `rc_members` row of the open rooms that user owns there (those
   rooms continue solo); `member.added` and `member.role_changed` delete
   nothing;
3. calls `applyOrgEvent(event)` on every room's object in parallel
   (`Promise.allSettled`); throws after trying them all if any rejected, so the
   queue retries the message; answers the total sockets cut.

The `rc_members` rows go first because they are what the dial door reads; the
`rc_rooms.org_id` column is **not** cleared by the consumer (§8.9). The RC
fan-out's failure is raised after the Workspace and Thread fan-outs have been
attempted, and the message is retried as a whole.

No new queue, producer or consumer is added. The erase door (`erase.ts`) calls
`endErasedRcRooms(env, orgId, workspaceId, sessionIds, erasedBy)` before it
settles the erasure tombstones: it selects open rooms with that `org_id`,
`workspace_id` and `session_id IN (…)`, and `POST`s `{ "reason": "erased" }` to
each object's `/close` with `X-Atlas-User-Id: <erasedBy>`, `X-Atlas-Rc-Room:
<id>` and `X-Atlas-Rc-Org-Admin: 1`; a non-`2xx` throws after every room was
tried, so the erase door's retry finishes it.

### 11.3 `RATE_LIMIT`

The existing binding (`namespace_id 3001`, `simple: { limit: 600, period: 60 }`)
is reused through `rateExceeded(env, key)`, which **fails open** (an outage of
the limiter refuses nothing). Keys:

| key | door | answer when exceeded |
| --- | --- | --- |
| `rc:{sub}` | every `/rc/*` REST request, before routing | `429` with `Retry-After: 60` (`backOff("too many requests; slow down")`) |
| `rc:dial:{userId}` | `/rc/host/ws` and `/rc/ws`, after the ticket is verified and before the room row is read | `429` (`backOff("too many connections; slow down")`) |

The object itself uses no platform limiter: its buckets (§8.6, §8.7) are
in-memory token buckets.

### 11.4 Deployment order

Migrations before workers, as the deploy workflow already does for every
worker with a database:

1. `pnpm exec wrangler d1 migrations apply atlas-auth --remote` — brings up
   `0045_rc_rooms.sql` (`rc_rooms`, `rc_members`, their three indexes and the
   partial unique index `rc_rooms_open_session ON (owner_user_id, session_id)
   WHERE status = 'open'`);
2. `pnpm exec wrangler deploy` for `atlas-ingest` — the `v3` migration tag
   creates the class; the doors start answering `/rc/*`;
3. `atlas-web` (`vite build` then `wrangler deploy`) — the `/api/rc/*` proxy and
   the `/rc/*` routes.

The order matters because the ingest doors read `rc_rooms` on every request
after `/init`, and the web proxy forwards to doors that must already exist. The
reverse order (web before ingest) answers `404` to the page until ingest lands,
which the page tolerates but shows as "no rooms".

A worker deploy disconnects every WebSocket on every room and discards
in-memory state. The design bounds what follows: every host and client redials
on its jittered backoff (hosts 1–30 s, §9), so the dial door's D1 reads spread
rather than land in one wave; a room reloads its ring from `tail_checkpoint`
and serves joiners from it; a host that redials with `as_of_seq !== head` is
asked for one snapshot. No manual step is needed around a deploy.

### 11.5 The kill switch

`rc.enabled` is a catalogued platform feature with `globalDefault: true` and
`orgDefault: false`. The **global layer** (`platform_feature_flags WHERE
feature = 'rc.enabled'`) is the kill switch:

```sql
INSERT INTO platform_feature_flags (feature, enabled, updated_at, updated_by)
VALUES ('rc.enabled', 0, <now>, '<who>')
ON CONFLICT(feature) DO UPDATE SET enabled = excluded.enabled;
```

Off, it refuses — with `403 { error: { code: "rc_refused", message: "Remote
control is turned off on this platform" }, gate: "platform_flag" }` — room
creation, every new dial on either socket (host redials included, so a
desktop that drops will not get back in), and every door that starts
something, for every room, solo or scoped. It **closes nothing** already open:
no socket is cut, no room ends, no token expires. Rooms already live run on
until their owner closes them or the owner-offline grace ends them.

The **org layer** (`org_feature_overrides WHERE org_id = ? AND feature =
'rc.enabled'`) governs only that Organisation's multiplayer — setting a scope on
it, inviting its members, and new dials by its members into rooms scoped to it
— answering `403 rc_refused` with `gate: "org_setting"` and the message "Remote
control for this organisation's members is not turned on. Ask an Atlas admin to
enable it; your own rooms still work." The owner's own rooms and dials are
untouched by an Organisation's layer.

Ops ends a specific room only through the owner, or — on a scoped room —
through a scope-Organisation admin's `POST /rc/rooms/{id}/close`; there is no
Ops door into a room, and a solo room can be ended by nobody but its owner or
its grace. `GET /rc/features` reports both layers to the clients as a drawing
hint; the doors re-read them on every start.

*Reference implementation:* `apps/ingest/wrangler.jsonc`,
`apps/ingest/src/org-events.ts`, `apps/ingest/src/rc-revoke.ts`,
`apps/ingest/src/limits.ts`, `.github/workflows/deploy.yml`.
