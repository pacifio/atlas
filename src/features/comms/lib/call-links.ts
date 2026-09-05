import type { ChatCall } from "../types";

/**
 * Join URLs are built CLIENT-side — the server returns no URL, only ids and
 * (for public calls) a `join_slug`. Shapes come from the web client:
 * members open `/call/{id}?org=` (auth-gated by their web session), guests
 * open `/j/{slug}` (unauthenticated knock page). A guest link exists only
 * when the call was started `public`; there is no way to add one later.
 */
const WEB_ORIGIN = "https://app.tryatlas.cc";

export function memberCallUrl(orgId: string, callId: string): string {
  return `${WEB_ORIGIN}/call/${encodeURIComponent(callId)}?org=${encodeURIComponent(orgId)}`;
}

export function guestCallUrl(joinSlug: string): string {
  return `${WEB_ORIGIN}/j/${joinSlug}`;
}

/** The link worth sharing: the guest door when one exists, else the member
 *  URL — matching what "copy the call link" means to the person clicking. */
export function shareUrl(orgId: string, call: ChatCall): string {
  return call.join_slug !== null ? guestCallUrl(call.join_slug) : memberCallUrl(orgId, call.id);
}
