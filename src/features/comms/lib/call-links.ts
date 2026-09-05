import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
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
  // Encoded even though the server mints 32-hex slugs: an unencoded value
  // here would let a misbehaving server craft an arbitrary same-origin
  // path+query and have us copy it as a trusted-looking share link.
  return `${WEB_ORIGIN}/j/${encodeURIComponent(joinSlug)}`;
}

/** The link worth sharing: the guest door when one exists, else the member
 *  URL — matching what "copy the call link" means to the person clicking. */
export function shareUrl(orgId: string, call: ChatCall): string {
  return call.join_slug !== null ? guestCallUrl(call.join_slug) : memberCallUrl(orgId, call.id);
}

/** Copy the share link with its toast — the one implementation of "copy the
 *  call link", used by the header menu and the timeline row alike. */
export async function copyShareLink(orgId: string, call: ChatCall): Promise<void> {
  const ok = await copyText(shareUrl(orgId, call));
  if (ok) toast.success(call.join_slug !== null ? "Guest link copied." : "Call link copied.");
  else toast.error("Could not reach the clipboard.");
}
