// The inbox at the size a busy reviewer's reaches: four hundred entries, one
// an hour, served fifty to a page as the server pages them. The default
// fixture's five rows scroll the same whatever a row costs to render; this is
// the inbox's counterpart to `timeline-long`, at the same density, so the two
// destinations' scrolling can be compared like for like.
//
// Built by cycling the default fixture's own rows, so every shape the page
// draws (a guest, a deleted comment, unread and read, each kind) recurs.

import type { InboxEntry, InboxPage } from "@/features/inbox/lib/inbox-api";
import { inboxHandlers } from "../fixtures/inbox";
import type { Scenario } from "../types";

const ROWS = 400;
const PAGE = 50;

let all: InboxEntry[] | null = null;

function entries(): InboxEntry[] {
  if (all) return all;
  const base = (inboxHandlers.artifacts_cloud_inbox({ filter: "all", cursor: null }) as InboxPage)
    .entries;
  const now = Date.now();
  all = Array.from({ length: ROWS }, (_, i) => {
    const from = base[i % base.length];
    const at = new Date(now - i * 3_600_000).toISOString();
    return {
      ...from,
      id: `${from.id}-x${i}`,
      createdAt: at,
      // A handful unread at the top, as an inbox left for a day has.
      readAt: i < 6 ? null : at,
    };
  });
  return all;
}

export const inboxLong: Scenario = {
  name: "inbox-long",
  description: `Inbox stress: ${ROWS} entries, one an hour, ${PAGE} to a page.`,
  commands: {
    artifacts_cloud_inbox: ({ filter, cursor }) => {
      const rows = entries().filter((e) =>
        filter === "unread"
          ? !e.readAt
          : filter === "mentions"
            ? e.kind === "artifact_mention"
            : true,
      );
      const start = cursor ? Number(cursor) : 0;
      const end = start + PAGE;
      return {
        entries: rows.slice(start, end),
        unread: entries().filter((e) => !e.readAt).length,
        nextCursor: end < rows.length ? String(end) : null,
      } satisfies InboxPage;
    },
    artifacts_cloud_inbox_unread: () => entries().filter((e) => !e.readAt).length,
  },
  setup: async () => {
    const { toggleDestination } = await import("@/features/layout/lib/destinations");
    toggleDestination("inbox");
  },
};
