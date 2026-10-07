/**
 * Who wrote a message, as the screen should say it — a member, or an
 * integration posting through an incoming webhook.
 *
 * Mirrors the web's `presentAuthor` (`apps/web/src/lib/webhooks.ts`), because
 * this is the impersonation guarantee and the two clients must not disagree on
 * it: an integration is **always** badged, and a per-message username override
 * always travels with the webhook's real name ("CI · via Deploy bot"), so a
 * webhook can never pass for a person. Before this the desktop looked the
 * webhook's `whk_…` id up as a member and printed "Unknown".
 */

import type { ChatMessage } from "../types";

type AuthorFields = Pick<ChatMessage, "author_id" | "author_kind" | "author_name" | "author_via">;

/** Was this message posted by an integration rather than a person? */
export function isWebhookMessage(m: Pick<ChatMessage, "author_kind">): boolean {
  return m.author_kind === "webhook";
}

export interface AuthorPresentation {
  /** The name on the line. */
  name: string;
  /** The webhook's own name, when the message overrode it; `null` otherwise. */
  via: string | null;
  /** Who actually posted it, for a tooltip. `null` for a person. */
  title: string | null;
  /** Draw the App badge. Always, for an integration. */
  badge: boolean;
}

export function presentAuthor(
  m: AuthorFields,
  personName: (id: string) => string,
): AuthorPresentation {
  if (!isWebhookMessage(m)) {
    return { name: personName(m.author_id), via: null, title: null, badge: false };
  }
  // Blank is absent: an override of "" or "  " must not draw a nameless line.
  const via = m.author_via?.trim() || null;
  const own = m.author_name?.trim() || null;
  const hook = via ?? own ?? "Integration";
  const name = own ?? hook;
  return {
    name,
    via: name === hook ? null : hook,
    title: `Posted by the “${hook}” webhook`,
    badge: true,
  };
}

/** The same, as one line of plain text — a reply stub, a notification. */
export function authorLabel(m: AuthorFields, personName: (id: string) => string): string {
  const p = presentAuthor(m, personName);
  if (!p.badge) return p.name;
  return p.via ? `${p.name} · via ${p.via} (app)` : `${p.name} (app)`;
}
