// Atlas account auth (ATL-35) — the frontend half.
//
// Every credential stays in Rust: the Better Auth session token and the access
// JWT never cross this boundary. What arrives here is `AuthSnapshot`, which
// carries identity and nothing secret. That split is deliberate — the renderer
// runs with no CSP and also displays agent-authored markdown, so a token in
// this heap would be one injection away from being exfiltrated.
//
// See src-tauri/src/auth for the state machine and src-tauri/src/commands/auth
// for the adapters.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** No credential stored. */
export interface SignedOut {
  status: "signed-out";
}

/** A device grant is in flight, awaiting approval in the browser. */
export interface Connecting {
  status: "connecting";
  /** Shown only behind the "enter the code manually" disclosure. */
  userCode: string;
  /** The plain approval URL, for that same manual fallback. */
  verificationUri: string;
  /** ISO-8601; the dialog stops offering a dead code past this. */
  expiresAt: string;
}

/** Who is signed in. Carries no credential — see the note at the top. */
export interface AccountUser {
  id: string;
  name: string;
  email: string;
  /**
   * Absolute path to the locally cached profile photo, or `null` when the user
   * has none or the fetch failed. Render it through `convertFileSrc`.
   *
   * Deliberately a local path rather than the provider URL: an `<img>` pointed
   * at Google or GitHub would tell them the user opened Atlas, every launch,
   * for a photo already on disk — and would leave the title bar blank offline.
   */
  avatarPath: string | null;
}

/**
 * A role in an organisation (API doc §6), highest privilege first.
 *
 * A union rather than `string` so `ROLE_LABELS` cannot silently lose a case:
 * the only thing the desktop does with a role is render its label, and a value
 * with no label renders as nothing at all.
 */
export type Role = "admin" | "product_owner" | "developer" | "member";

/** What each role is called on screen. Matches the web dashboard's wording. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  product_owner: "Product Owner",
  developer: "Developer",
  member: "Member",
};

/** One organisation the account belongs to (ATL-51). Read-only — see ATL-36. */
export interface AccountOrg {
  id: string;
  name: string;
  /**
   * `null` when the access token's `orgs` claim did not place the user in this
   * organisation, or named a role this build does not know. The organisation is
   * still real; only its label is missing.
   */
  role: Role | null;
}

/** A credential is held. */
export interface SignedIn {
  status: "signed-in";
  /**
   * `null` only between holding a credential and the first successful profile
   * fetch — a network blip right after approval, or an upgrade from a build
   * that stored no identity. The next validation fills it in; until then the
   * button shows the generic icon rather than nothing.
   */
  user: AccountUser | null;
  /**
   * Every organisation the user belongs to, from the stored snapshot — so this
   * is populated on an offline launch too.
   *
   * Three states, and the menu must render each differently:
   * - a non-empty array — known, and shown.
   * - `[]` — **known to be none.** The deliberate empty state.
   * - `null` — **not known yet**, because no list call has ever succeeded on
   *   this machine. Telling such a user they belong to no organisation would be
   *   a lie, and offline it is one nothing would ever correct — so the section
   *   is omitted, exactly as the identity header is when `user` is null.
   */
  orgs: AccountOrg[] | null;
  /**
   * Which of `orgs` this device is acting for, already resolved in Rust — the
   * one the user made active on the web, or the first they belong to. `null`
   * whenever `orgs` is empty or not yet known.
   */
  activeOrgId: string | null;
}

export type AuthSnapshot = SignedOut | Connecting | SignedIn;

export const auth = {
  /** Current state, for hydrating on mount. */
  snapshot: () => invoke<AuthSnapshot>("auth_snapshot"),
  /**
   * Begin or resume sign-in. Opens the approval page in the system browser and
   * polls in the background; resolves as soon as the grant starts, not when it
   * completes. Calling it again while one is in flight resumes the same grant
   * and reopens the browser rather than minting a competing code.
   */
  signIn: () => invoke<AuthSnapshot>("auth_sign_in"),
  /** Abandon an in-flight grant. Idempotent. */
  cancelSignIn: () => invoke<AuthSnapshot>("auth_cancel_sign_in"),
  /**
   * Sign out (ATL-50).
   *
   * Nothing here waits: Rust clears the credential, the identity snapshot and
   * the cached photo first and unconditionally, and the signed-out state
   * arrives over `atlas:auth-changed` before the server is contacted at all.
   *
   * Resolves — later, once the background revocation settles — to whether the
   * server confirmed the session is gone. `false` means this device is signed
   * out but the server session may stay active until it expires, which is the
   * one thing the user has to be told.
   */
  signOut: () => invoke<boolean>("auth_sign_out"),
  /**
   * Create an organisation server-side and link it (ATL-36) — the "Turn on
   * sync" action. Returns the server-issued id (the local org's `remoteId`) and
   * the name it was created under; carries no credential. The refreshed snapshot
   * that now lists the org also arrives over `atlas:auth-changed`.
   *
   * Rejects with a user-facing string on failure (e.g. name/handle taken,
   * offline). A rejection here never signs the user out — only a real 401 inside
   * Rust does, through the one path that may.
   */
  createOrg: (name: string, slug: string) => invoke<CreatedOrg>("auth_create_org", { name, slug }),
  /**
   * Is an organisation handle free? — the create-form typeahead probe (§6.2).
   *
   * A taken handle resolves `false`; it is not an error. Only a real failure
   * (no session, rate limit, unreachable) rejects, with a user-facing string.
   *
   * **Advisory only** — the server's unique index is the real guard, so
   * {@link auth.createOrg} can still fail on a race after a `true` here.
   */
  checkOrgSlug: (slug: string) => invoke<boolean>("auth_check_org_slug", { slug }),
  /**
   * Force a server re-pull of the account's organisations and re-broadcast the
   * snapshot — the manual refresh behind the org list. The merge is driven off
   * the resulting `atlas:auth-changed`, so the resolved snapshot is returned
   * only for callers that want it inline.
   */
  refresh: () => invoke<AuthSnapshot>("auth_refresh"),
  /**
   * Delete a synced organisation server-side (ATL-36), by its `remoteId`.
   *
   * Deleting is admin-only, so a member's call rejects with a user-facing
   * string — the caller removes the org locally either way. A rejection never
   * signs the user out; only a real 401 inside Rust does.
   */
  deleteOrg: (remoteId: string) => invoke<void>("auth_delete_org", { remoteId }),

  // ── Members (ATL-36) ──────────────────────────────────────────────────────
  // Every one of these rejects with a user-facing string; none can sign the
  // user out (only a real 401 inside Rust does that). `orgId` is always the
  // SERVER org id — the local org's `remoteId`, never its local `id`.

  /** The org's members. */
  listMembers: (orgId: string) => invoke<OrgMember[]>("auth_list_members", { orgId }),
  /** Pending + past invitations. Admin-scoped: a non-admin rejects, and the
   *  caller should render an empty invitations tab rather than an error. */
  listInvitations: (orgId: string) => invoke<OrgInvitation[]>("auth_list_invitations", { orgId }),
  /**
   * Invite by email. Email delivery is deferred server-side, so the resolved
   * `acceptUrl` is the ONLY way the invitee learns of the invite — surface it
   * for the inviter to copy.
   */
  inviteMember: (orgId: string, email: string, role: Role) =>
    invoke<OrgInvitation>("auth_invite_member", { orgId, email, role }),
  cancelInvitation: (invitationId: string) =>
    invoke<void>("auth_cancel_invitation", { invitationId }),
  /** Change a member's role. Takes effect in their NEXT minted token. */
  updateMemberRole: (orgId: string, memberId: string, role: Role) =>
    invoke<void>("auth_update_member_role", { orgId, memberId, role }),
  /** Remove a member. Re-broadcasts the snapshot — this can remove YOU. */
  removeMember: (orgId: string, memberIdOrEmail: string) =>
    invoke<void>("auth_remove_member", { orgId, memberIdOrEmail }),
};

/**
 * One person in an organisation. Mirrors Rust `OrgMember`.
 *
 * `id` is the MEMBERSHIP id (what role-change and remove address); `userId`
 * identifies the human. They are different ids and swapping them is a 400.
 *
 * No remote avatar URL, deliberately — see {@link AccountUser}. Rust resolves
 * the photo to a local cache path instead, so a members list costs no requests
 * to Google/GitHub on reopen.
 */
export interface OrgMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  /** `null` when the server named a role this build doesn't know — render no
   *  label rather than guessing at someone's permissions. */
  role: Role | null;
  createdAt: string | null;
  /** Absolute path to the cached photo, or `null` (no photo / fetch failed).
   *  Both render as initials. Feed it through `convertFileSrc`. */
  avatarPath: string | null;
}

/** A pending/past invitation. Mirrors Rust `OrgInvitation`. */
export interface OrgInvitation {
  id: string;
  email: string;
  role: Role | null;
  status: string;
  expiresAt: string | null;
  /** Only present on the response to {@link auth.inviteMember} — listing
   *  invitations does not re-issue a link. */
  acceptUrl: string | null;
}

/** The result of {@link auth.createOrg} — mirrors Rust `CreatedOrg`. */
export interface CreatedOrg {
  /** Server `organization.id`; becomes the local org's `remoteId`. */
  id: string;
  name: string;
}

/** Every auth transition, broadcast to every window. */
export const listenAuthChanged = (handler: (snapshot: AuthSnapshot) => void): Promise<UnlistenFn> =>
  listen<AuthSnapshot>("atlas:auth-changed", (e) => handler(e.payload));

/** A grant that ended without a token (denied, expired, unreachable). */
export const listenAuthError = (handler: (e: { message: string }) => void): Promise<UnlistenFn> =>
  listen<{ message: string }>("atlas:auth-error", (e) => handler(e.payload));

/**
 * The server rejected the stored credential and Atlas signed out (ATL-48).
 *
 * Separate from `atlas:auth-error` because it is read somewhere else: a grant
 * failure belongs inside the connect dialog the user is already looking at,
 * while this one arrives unprompted — a session revoked from the web, or one
 * that finally expired — and has to reach them as a toast.
 *
 * Only ever fires on an authoritative rejection. Being offline, an Atlas
 * outage, or a rate limit never produces this: those preserve the credential
 * and retry silently, which is the entire point of the classification.
 */
export const listenAuthSignedOut = (
  handler: (e: { message: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ message: string }>("atlas:auth-signed-out", (e) => handler(e.payload));
