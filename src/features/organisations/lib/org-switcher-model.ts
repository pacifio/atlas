/**
 * The organisation menu and create dialog's pure rules: who may open which
 * org, what the filter keeps, and how a typed name becomes a handle. No stores
 * and no IPC, so the views and their tests read the same functions the
 * containers do.
 */

import { isSyncedOrg, type Organisation } from "../types";

export type OrgAccess = { ok: true } | { ok: false; reason: string };

/** Two-letter avatar seed from an org name. */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Whether the current account may open `org` — and why not, for the tooltip.
 *
 * A LOCAL org is always accessible: it lives only on this machine and needs
 * no credential. A SYNCED org (`remoteId`) belongs to a server account, and
 * signing out or switching accounts must NOT keep you in someone else's org:
 *  - signed out → locked.
 *  - signed in, membership KNOWN, and this org isn't in it → locked.
 *  - membership UNKNOWN (offline, never listed) → allow; we can't prove a
 *    negative, and locking someone out of their own org on an offline launch
 *    is worse than the rare stale case.
 *
 * `memberOrgIds` is the server orgs THIS account belongs to; `null` = signed
 * out OR never listed on this machine.
 */
export function orgAccess(
  org: Organisation,
  { signedIn, memberOrgIds }: { signedIn: boolean; memberOrgIds: ReadonlySet<string> | null },
): OrgAccess {
  if (!isSyncedOrg(org)) return { ok: true };
  if (!signedIn) return { ok: false, reason: "Sign in to open this synced organization" };
  if (memberOrgIds && !memberOrgIds.has(org.remoteId)) {
    return { ok: false, reason: "This account isn't a member of this organization" };
  }
  return { ok: true };
}

/** The orgs a query keeps. Name AND slug: two orgs can share a display name,
 *  and the slug is what tells them apart on the server. */
export function filterOrgs<T extends Pick<Organisation, "name" | "slug">>(
  orgs: readonly T[],
  query: string,
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) return orgs;
  return orgs.filter((o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q));
}

// ── Create organisation ─────────────────────────────────────────────────────

/** The web origin an org handle lives under — shown as the static prefix. */
export const HANDLE_PREFIX = "app.tryatlas.cc/";

/** Don't probe the server until the handle is at least this long. Keeps the
 *  first keystroke or two from spending the shared 100-req/60s auth budget. */
export const MIN_HANDLE_FOR_CHECK = 2;

/** `disabled` regions render but can't be picked — EU isn't hosted yet, and
 *  showing it greyed is clearer than pretending US is the only place. */
export const REGIONS = [
  { id: "us", label: "United States", disabled: false },
  { id: "eu", label: "European Union", disabled: true },
] as const;
export type RegionId = (typeof REGIONS)[number]["id"];

/** Where the org lives. `local` is a real choice — private, offline, free —
 *  not a degraded mode; "Turn on sync" promotes it later. */
export type OrgMode = "cloud" | "local";

/** Availability of the typed handle. `idle` also covers "signed out", where
 *  there is no server to ask and the handle is only locally validated. */
export type SlugState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "error"; message: string };

/**
 * Handle transform. Deliberately NOT `slugify` from `../types`: that falls back
 * to the literal `"org"` for empty input, which pre-filled the field and fired
 * an availability probe before the user had typed anything.
 */
export function toHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "");
}

/** Same, but also trims a trailing "-" — for the value actually submitted. */
export function finalHandle(raw: string): string {
  return toHandle(raw).replace(/-+$/, "");
}

export function canSubmitCreate({
  submitting,
  name,
  handle,
  slug,
}: {
  submitting: boolean;
  name: string;
  /** The final handle (`finalHandle`). */
  handle: string;
  slug: SlugState;
}): boolean {
  return (
    !submitting &&
    name.trim().length > 0 &&
    handle.length > 0 &&
    slug.kind !== "taken" &&
    slug.kind !== "checking"
  );
}
