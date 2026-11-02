# Universal RC: decision audit against the product owner's requirements

Audit of every identity, scope, gating, naming, discovery, invite, link,
arbitration, limit and URL decision in `universal-rc-api-plan.md`,
`universal-rc-design-review.md`, `universal-rc-seam.md` and the code built from
them (server branch `feat/universal-rc` in `/Users/eemong/Codes/server`, desktop
branch `feat/universal-rc` in this repo), 2026-10-23. Research only; nothing was
edited. Every code claim cites `file:line` as read today. Server paths are
relative to the server repo, desktop paths to this one.

The Claude Code Remote Control research
(`docs/research/claude-code-remote-control.md`, "What this means for Atlas RC",
rules 1–18) is folded in: it is cited as **CC-n** below. Its headline rules are
that a session belongs to the signed-in *account* (CC-1/2), the phone signs in
to the same account and discovers sessions by a my-sessions list, a deep link
and a QR code (CC-5), all of the owner's own devices are live and may send at
once (CC §6), the phone may approve permissions and switch modes but never to
bypass (CC-16), individual plans get it with no org while Team/Enterprise is an
admin toggle (CC-18), and there is **no multiplayer precedent** — Atlas's
invite + single-driver design is an addition on top (CC "Where Atlas
deliberately diverges").

## The requirements (authoritative)

- **R1 — RC is personal first.** A room belongs to the *account* that owns the
  desktop. A developer with no org members, or no org at all, uses it fully:
  agent on the laptop, prompting from the phone, signed in as themselves.
- **R2 — Any agent.** Every installed ACP agent and the native Atlas Agent.
- **R3 — Multiplayer is optional and org + project scoped.** With a specific org
  and project selected in the app, the owner may invite only people of that org,
  in that project's scope. Nobody else.
- **R4 — Single driver.** Exactly one person can prompt at a time. After handing
  steering to A, *only A* can prompt — the owner cannot — until the owner takes
  it back. The owner stays master: take over, kick, close. Visitors watch and
  ask; the driver or owner approves.
- **R5 — Public links** (optionally password-protected) are subordinate: they
  must not force an org onto solo use.

## The one-line diagnosis

The plan copied its authority model from Shared Threads and Session Artifacts,
where *every* object is a tenant's (`thread:{org}:{ws}:{thread}`, `requireOrgMember`
on every door, `authorizeWsUpgrade` refusing without `?org=`), and never asked
"whose room is this?". Ownership (`owner_user_id`, an account) was recorded
correctly in the row, but every *door* in front of the row is keyed on an
Organisation: the create door, the list, the sockets, the feature flag, the DO
name, the viewer URL, and the desktop's `rc_start`. R1 was therefore
unimplementable by construction, and the stale-pin bug is just the first symptom.
R4 was weakened in one sentence of the plan ("the owner always may") and built
that way in the relay.

Nothing in the real-time design (host secret, relay-before-store, ring tail,
acks, placement, keepalives, redaction, tiers, link ceilings, Turnstile) is
affected. The fix is to the *scope* of a room, not its *mechanics*.

---

## 1. Decision table

Verdict legend: **keep** · **wrong** (contradicts a requirement) · **change**
(right idea, wrong scope or incomplete).

### 1.1 Identity and ownership

| # | decision | where | verdict | why, against the requirements | corrected decision |
| --- | --- | --- | --- | --- | --- |
| I1 | A room is owned by `owner_user_id` = the token's `sub`; only that account may host | plan §4.2, §5.1; `rc.ts:289-291`, `rc.ts:564-568`; migration `0045_rc_rooms.sql:25` | keep | This is R1 in the row, and it is exactly Claude Code's rule: the session "belongs to the claude.ai account … signed in at the time" and "grants no one else access" (CC-1, CC-2). The problem is everything around it. | Unchanged. Make it the *only* authority on who may open, host, list, manage and close a solo room. |
| I2 | Host binding = JWT + per-room host secret + `owner_client_id` | plan §4.1, §5.1, B-1/B-2; `rc-do.ts:707`; `rc.rs:28-31` | keep | Binds the host socket to the desktop that created the room; nothing org-shaped in it. | Unchanged. |
| I3 | The JWT proves `sub` + `orgs`; nothing else is minted per surface | `apps/auth/src/auth.ts:593-618`; `session-token.ts:75-116` | keep | A token with `orgs: {}` is still a valid proof of the account. That is exactly the solo user. | RC doors must accept a token whose `orgs` is empty. |
| I4 | "Every door names the Organisation with `?org=`; `400` without it; `403 forbidden` for a non-member" | plan §6 house conventions, §6.13; `rc.ts:79-82`; `errors.ts:43-52` | **wrong** | A room is the account's (R1). The org is a property of *multiplayer* (R3), not of the room's existence. Requiring it on the create/list/read/host/ws doors is what produces the 403 with no org or a stale one. | `?org=` becomes optional on every member door and is **ignored for authorisation**. Authorisation is `claims.sub == owner_user_id` or an `rc_members` row. `?org=` survives only as a list filter (the inbox's pattern, `notifications.ts:265-275`: subject-scoped, org as an optional filter). |
| I5 | Principal id = `user id` for members, `guest:{hex}` / `link:{linkId}` for link visitors | plan §4.2 | keep | Identity is account- or link-derived already. | Unchanged. |
| I6 | Precedent for an account-scoped feature: none cited; the plan cites only org-scoped threads/shares | plan §3.1 | change | The server already has account-scoped things to copy: the inbox (`notifications.ts:265`, `inbox(url, env, claims.sub)`), personal AI grants (`apps/auth/src/entitlements.ts:43-44`, `org_id = ''`; `packages/contracts/src/ai.ts:334` `AI_ORG_SENTINEL`; `apps/web/src/lib/ai.ts:29-31` "with no org declared the server looks for a personal one"), and the Artifact **Author** ("the Atlas account an Artifact belongs to. Always derived from the verified token", `CONTEXT.md:267`). | Cite these as the precedent for RC's subject-scoped doors. |
| I7 | Does every account have a personal org? | not addressed by the plan | finding | **No.** Signup hooks create nothing (`auth.ts:345-389`: PostHog + welcome mail only); the organization plugin only reacts to a create (`auth.ts:429-450`). The web shows a *user-driven* "Create your organization" form to a zero-org account (`apps/web/src/components/shell/no-workspace.tsx:34-61`). The prod org literally named "Personal" was typed by the user, not minted. The desktop's "local-only Organisation" is `org_id: None` (`src-tauri/src/auth/store.rs:181-195`). | Do not introduce auto-created personal orgs to paper over this. A solo room has `org_id = NULL`. |

### 1.2 Scope: org and workspace on a room

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| S1 | `rc_rooms.org_id TEXT NOT NULL` | plan §12.1; `0045_rc_rooms.sql:21`; `schema.ts` rcRooms | **wrong** | Forces every room into a tenant; a zero-org account cannot have a row at all. | `org_id` nullable. NULL = solo room. Set when multiplayer scope is attached (S4). |
| S2 | `workspace_id` nullable ("a room may be on an unregistered project") | plan §4.2; `0045_rc_rooms.sql:22` | keep | Already right. | Keep nullable; it only means something once `org_id` is set. |
| S3 | `/init` carries `orgId`; `room_state.org_id` is re-checked against the stamped org header on every request | `rc.ts:288-290`; `rc-do.ts:472-480`; `room_state.org_id TEXT` (`rc-do.ts:265`, already nullable) | change | The pair-check is a good contrivance guard, but the pair must be `(room_id, owner_user_id)`, not `(org_id, room_id)`. | Object stores `room_id`, `owner_user_id`, nullable `org_id`/`workspace_id`; re-checks `room_id` against `X-Atlas-Rc-Room` and the stamped user against owner/member state. |
| S4 | When the org/workspace is attached to a room: the plan fixes both at creation (`CreateRcRoomRequest.workspaceId`, org from `?org=`) | plan §6.2; `rc.ts:280-283, 325`; `rc.rs:206-220` | change | R3 says the *selected* org and project decide who may be invited. The desktop knows the selection; the server should receive it as the room's **scope**, nullable, and only need it when the owner invites. | Add `scope: { orgId, workspaceId: string \| null } \| null` to `CreateRcRoomRequest`, sent by the desktop only when the active org is a cloud org the token names *and* (optionally) the project is cloud-bound to it. Scope is **set-once**: NULL at creation may be set later by `PATCH /rc/rooms/{id} { scope }` (the desktop re-sends when the user picks an org); once non-NULL it never changes (changing the org would strand members). Invites and links that depend on org policy refuse `409 rc_no_scope` while NULL. |
| S5 | The Workspace is checked `mayRead` under `?org=` at creation | plan §6.2; `rc.ts:280-283` | change | Right check, wrong trigger. | Run `workspaceById(env, scope.orgId, scope.workspaceId)` + `mayRead` whenever a scope is set (create or PATCH), and require `scope.orgId ∈ claims.orgs` at that moment. |
| S6 | "Project scope" for invites is not defined by the plan (invites check org membership only) | plan §6.8 | change | R3: "people of that org (in that project's scope)". The server's project is the **Workspace** (`CONTEXT.md:11-16`), and Workspace readability is `mayRead` (`apps/ingest/src/registry.ts`, used at `rc.ts:282`). | Invite rule: each `userId` must be a member of `rc_rooms.org_id` **and**, when `rc_rooms.workspace_id` is set, pass `mayRead(workspace, userId)`. See open question Q2 for the unbound-project case. |
| S7 | Non-goal "cross-org rooms" | plan §1 | keep | A room's members all come from one org (R3). | Keep; solo rooms are *no-org*, not cross-org. |
| S8 | `org.deleted` / owner `member.removed` **ends** the room (`end_reason: org_deleted \| owner_removed`) | plan §12.3, §14.6; `RC_END_REASONS` `rc.ts:84`; web copy `rc.rooms.$roomId.tsx:48-49` | **wrong** | The room is the account's; losing the org loses the *multiplayer*, not the session. | On owner-removed or org-deleted: cut every member socket `1008`, delete `rc_members`, revoke org-policy-dependent links, set `org_id`/`workspace_id` NULL (or keep them as history and mark `scope_revoked_at`), audit `scope_revoked`. The room continues solo. `owner_removed` and `org_deleted` leave `RC_END_REASONS`. |
| S9 | Session erasure ends the room | plan §12.3 | keep | Erasure is per Workspace Session; applies only when the room has a workspace. | Keep; the query gains `AND workspace_id = ?`. |

### 1.3 Gating, flags, limits

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| G1 | Create / host dial / client dial are gated by `rc.enabled` **org layer** (`override ?? plan ?? orgDefault`), `orgDefault: false` | plan §6.2, §13.1, Q6; `rc.ts:259-260`, `rc.ts:572-573`; `features.ts:163-168`; `rc-do.ts:580-581` | **wrong** | A solo user is refused unless *some org* was granted the feature. R1 says solo RC is the baseline. Claude Code's shape is the one to copy: individual plans get it with no org at all; Team/Enterprise is an **admin toggle, off by default** on the org (CC-18). The plan's `orgDefault: false` is right for *that* toggle and wrong as a gate on the owner's own use. CC also notes the failure mode Atlas just hit: a Pro user "wrongly checked against a stale Team/Enterprise org from an earlier login" (CC §5). | Split the gate by room kind. **Solo room doors** (create without scope, owner host dial, owner client dial, `GET /rc/rooms`): only the platform layer (`featureLayers(rows,"rc.enabled").global`). **Multiplayer doors** (set scope, invite, member dial, link create when org policy applies): platform layer **and** the scope org's org layer. The catalogue entry stays; its `description` changes to say the org grant governs *inviting that org's members*. |
| G2 | Limits come from `featureAccessFor(orgId)` and are stamped on the socket | plan §13.2; `rc.ts:201-204`, `rc.ts:582` | change | No org → no limits object → `403` at `rc-do.ts:580`. | For a solo room use the catalogue defaults (`FEATURE_CATALOGUE["rc.enabled"].limits[k].default`) — the same numbers an ungranted org would get — and leave a hook for a personal grant later (precedent: personal AI grants, `entitlements.ts:43`). For a scoped room the org's effective limits apply to *member/link* capacity (`rc_participants`, `rc_links`); `rc_rooms`, `rc_tail_bytes`, `rc_offline_grace_ms`, `rc_command_burst` are per **account** and read from the platform defaults (or a future personal grant), never from the org. |
| G3 | `rc_rooms` ("Open rooms per person") is counted `WHERE org_id = ? AND owner_user_id = ?` | `rc.ts:268-272` | **wrong** | A per-person limit counted per org is neither. | `COUNT(*) WHERE owner_user_id = ? AND status = 'open'`, as plan §6.2's own text says. |
| G4 | Idempotent create resolves `(org, owner, sessionId)` | `rc.ts:357-364`; unique index `rc_rooms_open_session (owner_user_id, session_id)` `0045_rc_rooms.sql:43` | **wrong** (and a live bug) | The index is already account-scoped; the lookup is not. A room created under org A, then a desktop pinned to org B: `openRoomFor` finds nothing, the insert violates the index, `endOrphan` kills the new object, the winner lookup (again under B) finds nothing → `503`. | `openRoomFor` by `(owner_user_id, session_id)` only. |
| G5 | Kill switch = `rc.enabled` global layer; stops new starts, cuts nothing | plan §13.4, B-6 | keep | Platform lever, account-agnostic. | Unchanged; it is the *only* gate on a solo room. |
| G6 | Org policy columns `rc_public_links`, `rc_link_password_required`, `rc_link_steer` on `org_settings` | plan §12.1, §14.7 | change | Policy of an org applies to rooms **scoped to that org**; a solo room has no admin to set it. | Read `rcPolicy(org_id)` only when `org_id` is non-NULL; solo rooms use the defaults `{ publicLinks: true, linkPasswordRequired: false, linkSteer: true }`. The 15 s sweep skips rooms with NULL org. |
| G7 | Rate-limit keys `rc:{org}:{user}`, `rc:dial:{org}:{user}` | plan §6; `rc.ts:85`, `rc.ts:561` | change | Keyed on a value that may not exist. | `rc:{user}`, `rc:dial:{user}`. The public-door keys (`rc:link:{slug}`, `rc:pw:{slug}:{ip}`) are unchanged. |
| G8 | Org admins may `close` and read `audit`; never watch uninvited | plan §5.1, §6.10, §6.11, Q11, B-7; `rc.ts:518-521` | change | Correct for a scoped room (the thread precedent). Meaningless for a solo room, and today `visibleRoom(adminManages)` resolves the room *under the admin's org*, which a solo room has none of. | Admin powers exist only when `rc_rooms.org_id == the admin's org`. Solo room: owner only; Ops has the kill switch (B-6 stands). |
| G9 | `GET /rc/features?org=` is the client hint | plan §6.1; `rc.ts:221-233` | change | A solo desktop and phone need the hint too. | `GET /rc/features` (no org) → `{ enabled: platform, limits: account defaults }`; `GET /rc/features?org=` additionally → `{ multiplayer: { enabled: org layer, limits }, publicLinks, passwordRequired }`. |

### 1.4 Naming, URLs, discovery

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| N1 | DO name `rc:{orgId}:{roomId}` | plan §3.1, §4.2; `rc-names.ts:17-19`; `rc.ts:136-138` | **wrong** | The name is derived from a field that is NULL for solo rooms and set-once for scoped ones; a name must never depend on a mutable or absent field. `roomId` is a ULID minted by ingest (`rc.ts:286`), unique on its own. | `rc:{roomId}`. Placement rule (first `get()` from the create door's `/init`, B-17) unchanged. The object's contrivance guard becomes `room_id == X-Atlas-Rc-Room`. |
| N2 | Host socket `wss …/rc/host/ws?org=&room=`; client socket `/rc/ws?org=&room=` | plan §7.1; `rc.ts:549-558`; `host.rs:214-218`; `apps/web/src/lib/rc.ts:58-61` | **wrong** | `authorizeWsUpgrade` returns `400 missing org` / `403` without a membership (`upgrade.ts:108-111, 126-129`). A solo account cannot dial. | `?room=` only. The RC socket door verifies the ticket itself (`ticketFromSubprotocol` + `verifyAccessToken`, the two calls `upgrade.ts:115-124` makes) and resolves the principal from `claims.sub`; no org resolution. `stampIdentity` is replaced by stamping `X-Atlas-User-Id` only (the org/role headers are not needed by the object). Alternative: add `authorizeWsUpgradeSubject()` to `@atlas/do-protocol` beside the org one; recommended, so RC does not fork the JWKS path. |
| N3 | Viewer URL `{APP}/rc/rooms/{roomId}?org={orgId}` | plan §16 `joinUrl`; `crates/atlas-remote-control/src/lib.rs:99-106`; `rc.rs:262` | **wrong** | Carries an org the viewer may not be in, and that the room may not have. The web layout already treats `?org=` as legacy and strips it (`apps/web/src/routes/_app.tsx:83-110`). | `{APP}/rc/rooms/{roomId}`. Nothing else. |
| N4 | The web RC screens live under `_app`, which renders `<NoWorkspace />` for a zero-org account before any child route | `apps/web/src/routes/_app.tsx:136`; `rc.index.tsx:40-42`; `rc.rooms.$roomId.tsx:72-80` (`useOrg()`) | **wrong** | A solo account with no org never reaches `/rc/*` on the phone: it is shown "Create your organization". | `/rc/*` must render with a session and no org: either a sibling layout (`_session/rc.*`) that runs steps 1 and 3 of `_app`'s `beforeLoad` but not the org resolution, or an exemption in `AppLayout` for `/rc` paths. The room screen stops calling `useOrg()`; the member directory (`useOrgDetail`, `directoryOf`) is loaded only when `room.orgId` is non-NULL. |
| N5 | `GET /rc/rooms?org=` lists own + invited rooms *in that org* | plan §6.3; `rc.ts:436-445` | **wrong** | Discovery on the phone is "my rooms", across every org and none. Claude Code offers three doors and Atlas should match: a my-sessions list with an online dot, a deep link with the session id, and a QR code of that link in the host UI (CC-5); the desktop today offers only "Copy link" (`use-remote-control.ts:40-46, 60-62`). | `GET /rc/rooms` → `WHERE owner_user_id = ?1 OR id IN (SELECT room_id FROM rc_members WHERE user_id = ?1)`, no org predicate; each `RcRoom` carries `orgId: string \| null`, `workspaceId` and `hostOnline` so the list can group and show the dot. `?org=` optional filter. Desktop adds a QR of the viewer URL beside "Copy link" (D8). |
| N6 | `GET /rc/rooms/{id}?org=` resolves `roomById(org, id)` | `rc.ts:170-174`, `rc.ts:421-433` | **wrong** | Same. | `roomById(id)`; visibility = owner or `rc_members` row (or admin of `row.org_id`, G8). |
| N7 | `GET /rc/invites?org=` for the notification center | plan §6.12, §16 | change | Pending invites are per person. | `GET /rc/invites` (no org), rows grouped by `orgId` for the centre's per-org badges (the `/inbox/unread` shape, `notifications.ts:269-275`). |
| N8 | `rc.welcome` to the host carries `orgId: string` (required) | `packages/contracts/src/rc.ts:964-965`; plan §7.3 | change | Must be nullable. | `orgId: string \| null`, plus `workspaceId: string \| null` so the desktop can show "shared with <org> · <project>". Fixtures updated. |
| N9 | `RcRoom.orgId: string` on every door | `packages/contracts/src/rc.ts:423-425`; `rc-api.ts:28-31`; `rc.rs:65, 81` | change | Nullable. | `orgId: string \| null`. |
| N10 | Web proxy mints the ticket with `url.searchParams.get('org')` | `rc-proxy.ts:145`; `session-token.ts:75-88` | keep | Already optional: with no `orgId` the cached token is reused unconditionally. | Unchanged; add a test for the no-org path. |
| N11 | Proxy allow-list (no `POST /rooms`, no `/host/ws` from a page); Origin check | plan §15; `rc-proxy.ts:73-92, 135-137` | keep | Scope-neutral. | Unchanged. |
| N12 | `rc_invite` e-mail `joinUrl = {APP}/rc/rooms/{roomId}?org=` | plan §16 | change | Same as N3. | Drop `?org=`. |

### 1.5 Invites, links, public door

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| V1 | Invite = `rc_members (room_id, user_id)`; each id must be a current member of the Organisation named by `?org=` | plan §6.8; migration `0045_rc_rooms.sql:8-16` | change | The org must be the **room's** scope, not the caller's query string, and project scope is missing (S6). | Refuse `409 rc_no_scope` while `org_id` is NULL; check membership of `rc_rooms.org_id`; apply `mayRead` on `workspace_id` when set. Non-qualifying ids are skipped and named in `notes` (plan's rule, kept). |
| V2 | A member may remove only themselves; the owner anyone | plan §6.8 | keep | — | Unchanged. |
| V3 | `member_tier` chosen by the owner, up to `steer_approve`; links capped at `steer` and only with a password | plan §5.4, §11.2, Q2 | keep | Orthogonal to scope. | Unchanged. |
| V4 | `rc_links.org_id NOT NULL` "denormalised so the slug lookup is one read"; the public info door returns `org_name` | plan §12.1, §6.9 | change | A solo room's links have no org; the public page must not require one (R5). | `rc_links.org_id` nullable (or dropped: the slug lookup joins `rc_rooms` anyway, plan §6.9 step 2). The info door returns `host_name` (the owner's display name) and, when scoped, `org_name`; never requires either. |
| V5 | Org policy gates link creation and the public door (`rc_public_links` off → `410`) | plan §6.6, §6.9 step 3, §14.7 | change | Only when the room is scoped (G6). | `rcPolicy` is consulted iff `rc_rooms.org_id` is non-NULL. A solo owner's links are governed by the platform flag, Turnstile and the password ceilings only. |
| V6 | Link visitors learn counts + driver name; members' ids never cross; no `roomId` to a link socket | plan §7.6, §14.5, Q3 | keep | — | Unchanged. |
| V7 | Links subordinate to membership (no `steer_approve`, `set_config_option` members-only) | plan §5.4, B-8 | keep | — | Unchanged. |

### 1.6 Driver arbitration

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| A1 | One Driver, epoch counter, request/grant/decline/timeout, kick, take-over, release, driver-loss grace | plan §9.1–§9.5; design review D3 | keep | This is R4's mechanism. | Unchanged. |
| A2 | **"`submit`, `stop`: owner — yes, always"**; the relay gate admits `owner OR driver` | plan §5.4 matrix row `submit, stop`; §10 "is Driver or owner"; §9.3 "the owner always wins"; design review §4.1 "answerable by whoever holds the token at answer time, plus the owner at any time"; **`rc-do.ts:1320-1322`** (`if (s.principal.id !== owner_user_id && s.principal.id !== driver_id) refuse not_driver`) | **wrong** | R4: after handing steering to A, "only A can prompt — I can't, until I take it back". The built gate lets the owner prompt from the phone while A drives, and the desktop's steering entry has no equivalent gate for the owner's *local* composer either (`rc.rs` ports commands through `AgentHost` with `Origin`; nothing refuses a local submit while a remote driver holds the seat). | **Steering commands (`submit`, `set_mode`, `set_model`, `set_config_option`, `answer_elicitation`) are Driver-only, the owner included.** Relay: `if (s.principal.id !== driver_id) refuse not_driver` — the owner's socket gets `not_driver` with a hint `takeOver: true`. Desktop: the steering entry refuses a local `submit`/`set_*` with `Origin::Local` while `driver != owner`, and the composer shows "A is driving — Take over". **Master powers stay owner-only and unconditional:** `stop` (the kill switch of design review §4.5), `rc.kick`, `rc.take_over`, `rc.close`, `rc.control_answer`. `answer_permission` is open question Q3. **The seat is held by a principal, not a socket:** while the owner drives, every one of the owner's surfaces (desktop composer, phone, web) may send interchangeably — Claude Code's rule for the owner's own devices (CC §6: "send messages from your terminal, browser, and phone interchangeably"; no driver lock among them) — and the same holds for a member Driver's several tabs. R4's exclusivity is between *people*. |
| A3 | `rc.take_over` is a no-op; `rc.control_answer` always answers `request_unknown`; `rc.request_control` unimplemented ("the owner always drives, arbitration comes later") | `rc-do.ts:97-99`, `rc-do.ts:1431-1452`, `rc-do.ts:669-673` | change | Build gap, not a wrong decision — the room is wired so the owner is the permanent driver. | Implement §9.2–§9.3 as planned, with A2's gate. The desktop needs the matching UI (request list, approve/decline, take over). |
| A4 | Owner answers control requests from the desktop host socket **or** any of their client sockets | plan §9.2 step 2, §9.3 | keep | The owner on their phone is the owner (R1). | Unchanged; the owner's identity is `claims.sub`, no org needed. |
| A5 | Driver-loss grace returns the seat to the owner | plan §9.5 | keep | — | Unchanged. |
| A6 | A pending permission prompt is answerable by a `steer_approve` Driver; "first answer wins" with the owner's local card | plan §9.4; design review §4.4 "The desktop always shows the card too; first answer wins" | change | Potentially conflicts with R4's "exactly one person can prompt". A permission answer is consent, not a prompt; the machine executing it is the owner's. | Recommend keeping the owner's local permission card answerable at all times (the safety argument), while the owner's *remote* `answer_permission` follows the Driver rule. See Q3; the product owner decides. |

### 1.7 Desktop

| # | decision | where | verdict | why | corrected decision |
| --- | --- | --- | --- | --- | --- |
| D1 | `rc_start` requires `ArtifactsCloudState::org_id()` and errors "Remote control needs a signed-in Atlas organisation" | `src-tauri/src/commands/rc.rs:18-25, 200-205` | **wrong** | R1. The org here is the Timeline's target — whatever the renderer last passed to `artifacts_cloud_retarget` (`src-tauri/src/commands/artifacts_cloud.rs:272-284`, from `App.tsx:356-369` `active?.remoteId`), which derives from the pin (`src-tauri/src/auth/core.rs:581-583`: "A pin wins outright"). A stale pin → `?org=<gone>` → `403 forbidden` (`errors.ts:43-52`). A local-only org → `None` → the error string. | `rc_start` needs only a signed-in session (`AuthState`, the `AppTokenSource` at `artifacts_cloud.rs:66-78` already mints from it). The org is read as a **scope hint**: `ArtifactsCloudState::org_id()` *if* that id appears in the stored identity's `orgs` (`store.rs:131, 160-166`); otherwise `None`. `workspace_for(cwd, org)` (`rc.rs:424-440`) runs only when a hint exists. The room is bound to the account signed in at start: a sign-out or a sign-in as a different account on the desktop closes every room this desktop hosts, leaving the local sessions running (CC-1: "a sign-in change on the host ends the RC session but leaves the local session running"). |
| D2 | `CreateRoomRequest` has `workspace_id` but no org; org rides the URL | `crates/atlas-remote-control/src/rest.rs:4-10, 229-244` | change | Mirror of S4. | `scope: Option<Scope { org_id, workspace_id: Option<String> }>` in the body; `url()` takes no org. |
| D3 | Host dial `/rc/host/ws?org=&room=`; `HostConfig.org_id: String` | `host.rs:19, 145, 181-192, 214-218` | **wrong** | N2. | `?room=` only; `org_id` leaves `HostConfig`. `host.rs:1068` error text "not available for this organisation" → "Remote control is turned off" (platform). |
| D4 | `viewer_url(org, room)` | `lib.rs:99-106`; test `lib.rs:115-119` | **wrong** | N3. | `viewer_url(room)`. |
| D5 | `RcRoomWire.org_id: String`, `RcStarted.org_id`, TS mirrors | `rc.rs:65, 81, 190, 266, 322`; `src/features/chat/lib/rc-api.ts:28-31, 45-49` | change | Nullable scope, plus the workspace for display. | `scope: Option<{ org_id, workspace_id }>` / `scope: { orgId; workspaceId } \| null`. |
| D6 | The room survives tab close / project switch via the session hold; closing RC ends the room | `rc.rs:9-16`; design review D7 | keep | — | Unchanged. |
| D7 | Any agent: capabilities are advertised from `snapshot_meta` (`available_modes`, `available_models`, `config_options`), agent id from `plugin_id` | `rc.rs:208-230` | keep | R2 holds; nothing agent-specific anywhere (ADR-0002). | Unchanged. |
| D8 | Desktop UI: start/stop/copy link in the header; the status pill | `use-remote-control.ts`, `rc-status-pill.tsx`, `chat-header.tsx:135, 219` | change | Needs: a QR code of the viewer URL beside "Copy link" (CC-5), an invite affordance that appears only when a scope exists, the driver indicator and "Take over", and the request list (A3). | Additive; see §3. |
| D9 | The owner's phone may answer permission prompts and change modes; the desktop's `widening` gate refuses bypass/full-access modes and standing (`AllowAlways`) grants from any remote surface | plan §5.4, §11.1 gates 12–13; design review §4.4 | keep | Matches Claude Code exactly: the phone can approve permissions and switch permission mode "but you can't select Bypass permissions from the app" (CC-16). Atlas is stricter on standing grants, which is fine. | Unchanged. |
| D10 | Host offline → room stays open for `rc_offline_grace_ms` (default 10 min, max 1 h), then ends; redial on wake | plan §13.1, D7; `rc-do.ts:1494` | change | Claude Code keeps an offline session *resumable* for ~4 h and only then cleans up (CC-9/10); 10 min means a lunch break ends the room and the phone's link dies. | Raise the default grace to 1 h and the catalogue max to 4 h for the *account* limit (G2); the room is "offline, not deleted" in the phone's list (CC-9). Open question Q8. |

### 1.8 Things the plan got right that the requirements depend on

Kept without change, listed so nobody "fixes" them while re-scoping: the host
secret and the idempotent `200 { hostSecret: null }` (B-1/B-2); relay-before-store,
the in-memory ring, acks and the in-flight budget (B-10–B-12); placement by the
create door's `/init` (B-17; still the first `get()` on `rc:{roomId}`); redaction on
the desktop before egress; the three tiers and the link ceilings (§11.2); Turnstile
on every link; the epoch rule on commands (§9.1); the no-queue-while-offline rule
(D7); no admin spectating (Q11; now only for scoped rooms); audit retention and
erasure (§12.3); capability advertisement from the desktop (R2).

---

## 2. The corrected model

**Ownership.** A room belongs to one **account**: `rc_rooms.owner_user_id =
claims.sub`. That account may open, host, list, watch, manage and close the room
from any surface — the desktop (host socket + secret) or the phone/web (client
socket, role `owner`, tier `steer_approve`). No org is consulted for any of
this. A token with `orgs: {}` is sufficient. This is Claude Code's model
verbatim (CC-1/2): the session belongs to the account signed in on the host at
start; the phone signs in as the same account; a sign-in change on the host
ends the room and leaves the local session running.

**Scope.** `org_id` and `workspace_id` are a nullable, **set-once** pair called
the room's *scope*. NULL means a solo room. The desktop sends the scope at
creation when its active org is a cloud org the token names (and, when the
project is cloud-bound to that org, the Workspace), or sets it later with
`PATCH /rc/rooms/{id} { scope }` when the user picks an org; the server verifies
`scope.orgId ∈ claims.orgs` and `mayRead(workspace)` at that moment. Once set it
never changes; on owner-removed/org-deleted the scope is *revoked* (members cut,
rows deleted, scope cleared) and the room continues solo. The scope exists to
answer one question — "whom may the owner invite?" — and to decide whose org
policy applies to links.

**DO naming.** `rc:{roomId}`. The object stores `room_id`, `owner_user_id` and
the nullable scope; it re-checks `room_id` against `X-Atlas-Rc-Room` on every
request and decides owner/member from its own state and the stamped user id.
Placement unchanged.

**Gating.**

| door | solo room | scoped room |
| --- | --- | --- |
| create (no scope) / owner host dial / owner client dial / list / read / close by owner | platform `rc.enabled` global layer only; account defaults for limits; `rc_rooms` counted per account | same |
| set scope / invite / member dial | n/a (`409 rc_no_scope`) | platform layer **and** the scope org's `rc.enabled` org layer; `rc_participants` from that org's limits; invitee ∈ org members ∩ Workspace readers |
| link create / public info / unlock / link dial | platform layer; Turnstile; password rules; defaults `{publicLinks: true, passwordRequired: false, linkSteer: true}` | platform layer; the scope org's `rcPolicy` |
| admin close / audit | owner only | owner, or an admin of the scope org |

**Who may connect.** Solo: only `owner_user_id`, on any surface; everyone else
`404`. Scoped: the owner, plus `rc_members` rows; org admins without a row `404`
(they may close). Link visitors: by link token, either kind.

**Invites.** Allowed only while scoped. Each `userId` must be a current member of
`rc_rooms.org_id` and, when `workspace_id` is set, a reader of that Workspace
(`mayRead`). The desktop's invite picker lists exactly that set and nothing else.

**Single driver (R4).** `driver` starts as the owner (epoch 1). While
`driver != owner`, the owner's steering commands (`submit`, `set_mode`,
`set_model`, `set_config_option`, `answer_elicitation`) are refused `not_driver`
by the relay **and** by the desktop's steering entry for the local composer; the
owner's UI offers *Take over*. Master powers (`stop`, `kick`, `take_over`,
`close`, `control_answer`) are owner-only and never gated by the seat. Visitors
with tier ≥ `steer` may `request_control`; the Driver or the owner answers.
`answer_permission` from the owner's local card: see Q3. The seat belongs to a
*person*: all of the owner's own surfaces send interchangeably while the owner
drives (CC §6), and Atlas's handoff to another person is the addition Claude
Code does not have (CC "Where Atlas deliberately diverges") — so the owner's
invariants from CC hold throughout: the owner's host is the single authority, a
guest's rights are a strict subset of the owner's, and no guest can touch the
host's sign-in, policy or bypass mode.

**Public links.** Unchanged in mechanism, subordinate in scope: they never create
or require an org; the policy that can restrict them is the scope org's, and only
when there is one.

**Discovery.** Three doors, as Claude Code (CC-5): `GET /rc/rooms` (no `?org=`)
returns every room the caller owns or was invited to, across all orgs and none,
open first, with `hostOnline` for the status dot; each row carries its nullable
scope so the phone can group by org/project. The viewer URL is the deep link,
and the desktop shows it as a QR code beside "Copy link". `GET /rc/invites`
likewise.

**Viewer URL.** `{APP}/rc/rooms/{roomId}`. The web `/rc/*` screens require a
session, not an org, and load the org directory only when the room is scoped.

**Stale pinned org, after the fix.** `rc_start` never fails on the org. If the
pin names an org the identity no longer lists, the scope hint is `None`, the room
is created solo, the host dials `/rc/host/ws?room=`, and the viewer link works on
the phone. The only visible effect of the stale pin is that the invite affordance
is absent until the user picks a valid org, at which point the desktop PATCHes the
scope. The `openRoomFor` race in G4 cannot occur because idempotency is
`(owner, session)`.

---

## 3. Change list

Ordered so each step is green on its own (contracts first, then storage, then
doors, then clients). Migration `0045` is untracked on the branch (`git status`:
`?? packages/db/migrations/0045_rc_rooms.sql`), so it is edited in place; if it
has already been applied to a remote D1, write `0046` that recreates `rc_rooms`
with the nullable column instead.

### 3.1 Server — contracts (`packages/contracts`)

1. `src/rc.ts`: `RcRoom.orgId: string | null`; add `RcScope { orgId: string;
   workspaceId: string | null }` and `RcRoom.scope`-style fields (or keep the two
   nullable columns); `CreateRcRoomRequest` gains `scope: RcScope.nullable()` and
   loses `workspaceId`; `UpdateRcRoomRequest` gains `scope?: RcScope` (set-once);
   `RcHostWelcome.orgId` → nullable, add `workspaceId`; add error codes
   `rc_no_scope` (409), `rc_scope_set` (409, scope already set); drop
   `owner_removed` / `org_deleted` from `RC_END_REASONS`; add audit events
   `scope_set`, `scope_revoked`; `RcFeaturesResponse` gains the `multiplayer`
   sub-object (G9). Update `RC_FRAME_FIXTURES` and `fixtures/rc-frames-v1.json`.
2. `src/features.ts:163-168`: reword the `rc.enabled` description ("…the
   Organisation's grant governs inviting its members into a room; a member's own
   rooms need only the platform switch").
3. Tests: `apps/auth/test/features.test.ts`, `apps/chat/test/features.test.ts`
   (catalogue snapshots), contract fixture equality tests.

### 3.2 Server — storage (`packages/db`)

4. `migrations/0045_rc_rooms.sql:21`: `org_id text` (nullable); keep
   `rc_rooms_by_org` (for scope-revocation fan-out) and the account-scoped
   unique index. Regenerate `meta/0045_snapshot.json`; `src/schema.ts` rcRooms
   `orgId` nullable.

### 3.3 Server — ingest doors and object (`apps/ingest`)

5. `src/rc-names.ts:17-19`: `rcDoName(roomId)`.
6. `src/rc-do.ts`: `RcInit.orgId` nullable + `workspaceId`; `fetch()` pair-check
   (`:472-480`) → `room_id` only; `upgrade()` (`:580`) takes limits from the
   header as today but the door always sends them; add `/scope` internal door
   (set-once, re-badges nothing); `applyOrgEvent` → scope revocation instead of
   `end`; **command gate `:1320-1322` → Driver-only** (owner refused
   `not_driver` unless `kind === "stop"`); implement `take_over`, `control_answer`,
   `request_control`, `release_control` per plan §9.
7. `src/rc.ts`: `serveRc` drops the `?org=` requirement and `requireOrgMember`
   (`:79-82`); rate key `rc:{user}`; `access()` becomes `platformAccess()` (global
   layer + catalogue defaults) and `orgAccess(orgId)` (as today) used only on
   scope/invite/member paths; `create` (`:259-283`) → platform gate, per-account
   limit, scope validation when present; `openRoomFor` (`:357-364`) by
   `(owner, session)`; `roomById(id)`; `list` (`:436-445`) subject-scoped with
   optional org filter; `visibleRoom` admin branch conditioned on
   `row.org_id === caller.orgId`; `close` likewise; new `PATCH` field `scope`
   (set-once); `serveRcSocket` (`:549-583`) → `?room=` only, verify the ticket
   via a new `authorizeWsUpgradeSubject()` in `packages/do-protocol/src/upgrade.ts`
   (same JWKS path, no org), stamp `X-Atlas-User-Id` only, resolve owner/member
   from the row; rate key `rc:dial:{user}`.
8. `src/index.ts:102-103, 139-140`: unchanged wiring.
9. Later slices (invites, links, public door) are written against the corrected
   model from the start: invite door checks `rc_rooms.org_id` membership +
   `mayRead(workspace_id)`; `rc_links.org_id` nullable; `rcPolicy` consulted only
   when scoped; public info door returns `host_name` (+ `org_name` when scoped).
10. Tests (`apps/ingest/test`): `rc-client.ts:55-64` `rcDoor` makes `?org=`
    optional; `rc-rooms.test.ts:74-79` ("names its Organisation in ?org= only")
    becomes "needs no org: a token with `orgs: {}` creates, lists, reads and
    closes its own room"; add "a stale/foreign `?org=` is ignored"; "limit is per
    account across orgs"; "idempotent create across a pinned-org change";
    "scope set-once"; "invite refused `rc_no_scope`"; "owner cannot `submit`
    while a member drives, can `stop`, `take_over`"; `rc-host.test.ts`/
    `rc-join.test.ts` `openHost(org, …)` helpers lose the org.

### 3.4 Server — web (`apps/web`)

11. `src/lib/rc.ts:40-61`: `fetchRcFeatures(orgId?)`, `listRcRooms()`,
    `rcSocketUrl(roomId, origin)`; `src/lib/queries/rc.ts` keys without org.
12. `src/lib/use-rc-room.ts:186, 411`: `useRcRoom(roomId)`.
13. Routes: move `rc.index.tsx` and `rc.rooms.$roomId.tsx` under a layout that
    requires a session but not an org (or exempt `/rc` from `_app.tsx:136`'s
    `NoWorkspace`); replace `useOrg()` with `room.orgId`-conditional directory
    loading; group the list by scope.
14. `src/lib/rc-proxy.ts`: no change; add a no-`?org=` case to
    `rc-proxy.test.ts`; `use-rc-room.test.tsx:121` asserts *no* `org` param.

### 3.5 Desktop — crate (`crates/atlas-remote-control`)

15. `src/rest.rs`: `CreateRoomRequest.scope: Option<Scope>`; `url()` without
    `org`; `RoomWire.org_id` → `scope`.
16. `src/host.rs:145-218`: `HostConfig` loses `org_id`; dial URL `?room=`; test
    `:1152-1168` updated; `:1068` message.
17. `src/lib.rs:99-119`: `viewer_url(room_id)`; test updated.
18. `src/wire.rs`: `HostWelcome.org_id` nullable + `workspace_id`; fixtures under
    `tests/fixtures` and `tests/contract.rs` follow the contracts change.
19. `src/gate.rs`: the local-origin gate — refuse local steering while a remote
    driver holds the seat (A2).

### 3.6 Desktop — app (`src-tauri`, `src`)

20. `src-tauri/src/commands/rc.rs:200-206`: drop the org requirement; compute the
    scope hint (`ArtifactsCloudState::org_id()` ∩ stored identity `orgs`), call
    `workspace_for` only with a hint; `RcRoomWire`/`RcStarted` carry `scope`;
    add `rc_set_scope(sessionId)` for the later-pick case and `rc_invite`,
    `rc_take_over`, `rc_answer_control` as the server slices land.
21. `AgentHost` steering entry: refuse `Origin::Local` `submit`/`set_*` while a
    remote driver holds the seat; emit the driver on `atlas:rc`.
22. `src/features/chat/lib/rc-api.ts`, `stores/rc-store.ts`: `scope` nullable,
    `driver` on the wire mirror; `use-remote-control.ts` + `rc-status-pill.tsx`:
    "A is driving — Take over", invite affordance only when `scope` is set, a QR
    code of `viewerUrl` next to "Copy link" (CC-5; a small QR primitive in
    `src/ui/`, no new top-level dependency without discussion).
22a. `src-tauri/src/auth/core.rs` sign-out / re-grant path: close every hosted
    room (`rc_stop` for each) before the credential changes (CC-1).
23. Tests: `rc.rs:598-610` wire-shape test; vitest for the store/pill; mock
    backend fakes for the new commands (`src/dev/mock-backend`).

---

## 4. Open questions

Only where the requirements do not decide; each with a recommended answer.

**Q1. Scope at creation or at first invite?** The desktop always knows the
active org; sending it at creation is simpler, but a room opened while the pin is
stale would then have no scope until the user acts. *Recommend:* send at creation
when valid, allow set-once later via PATCH. Never changeable after.

**Q2. Project scope when the project is not cloud-bound.** R3 says "in that
project's scope"; a local-only project has no Workspace. (a) Org-wide invites;
(b) refuse invites until the project is bound. *Recommend (a)* with the picker
labelled "Everyone in <org>" so the owner sees the widening; (b) is the stricter
reading if the product owner wants it.

**Q3. May the owner answer a permission prompt locally while someone else
drives?** R4 is about prompting. A permission answer executes on the owner's
machine and is consent rather than steering. *Recommend yes* for the local card
(and `stop`), no for the owner's remote `answer_permission`; confirm with the
product owner, since "only A can prompt" could be read to cover approvals.

**Q4. Should the owner's `stop` be seat-gated?** *Recommend no*: it is the
master's kill switch (design review §4.5) and never widens anything.

**Q5. Personal limits.** The catalogue defaults serve solo rooms today. Whether
a solo account can be *granted* more (personal plan) is a billing decision;
the personal-AI-grant precedent (`entitlements.ts:43`) is the shape to reuse.
*Recommend* defaults only until a plan asks.

**Q6. What ends a solo room when the account is deleted?** The plan's Q18
(no `user.deleted` event) remains. *Recommend* the desktop's sign-out/
account-change path closes its own rooms (CC-1 makes this the rule, not a
fallback), and the grace TTL covers a deletion made elsewhere.

**Q7. Does Atlas want Claude Code's "device card" (phone starts a new session
on the laptop)?** CC-6 is server mode only. *Recommend not in v1*: Atlas's
unit is a running session (`rc_start(sessionId)`, `rc.rs:179`), and spawning
sessions from the phone is a separate feature with its own consent prompt.

**Q8. Offline grace: 10 min (plan) or hours (Claude Code's ~4 h resume
window, CC-10)?** The DO hibernates while idle, so a long grace costs little.
*Recommend* 1 h default, 4 h max, and the room shown as "offline" in the list
rather than vanishing (D10).

**Q9. Device trust as a later layer.** CC-3 ties access to an enrolled device
plus a recent sign-in, optional and off by default. *Recommend* no v1 work, but
keep the host-secret and `owner_client_id` binding as the hook (I2) and do not
design anything that assumes "account == device".
