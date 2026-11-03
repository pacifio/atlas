// The Organisation inbox, faked: a few days of mentions, replies and comments
// on your Sessions in the mock Organisation, two of them unread, one from a
// guest and one whose comment was deleted — every row shape the page draws.
// Members are the mock roster's (`integrations.ts`), so names and faces
// resolve the way they do against the real directory; the Sessions are the
// synced app Project's (`artifacts.ts`), so opening a row lands on the
// Timeline. Marking read is remembered for the life of the page.

import type { InboxEntry, InboxPage } from "@/features/inbox/lib/inbox-api";
import type { TypedHandlers, Unit } from "../types";

export interface InboxResponses {
  artifacts_cloud_inbox: InboxPage;
  artifacts_cloud_inbox_unread: number;
  artifacts_cloud_inbox_read: Unit;
}

const DAY = 86_400_000;
const at = (daysAgo: number, hour: number) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
};

function entry(
  id: string,
  over: Partial<InboxEntry> & Pick<InboxEntry, "kind" | "actorId" | "createdAt">,
): InboxEntry {
  return {
    id,
    orgId: "org-mock",
    workspaceId: "rw_1d55e903",
    workspaceSlug: "atlas",
    sessionId: "sess-a19c40",
    sessionTitle: "Regenerate the dark-mode ramp from the shadcn base tokens",
    commentId: `cm_${id}`,
    anchorKind: "session",
    anchorId: "sess-a19c40",
    actorName: null,
    excerpt: "",
    readAt: null,
    path: "",
    ...over,
  };
}

const ENTRIES: InboxEntry[] = [
  entry("n1", {
    kind: "artifact_mention",
    actorId: "usr_priya",
    excerpt: "@dev can you check the contrast on the muted ramp before we ship this?",
    createdAt: at(0, 10),
  }),
  entry("n2", {
    kind: "artifact_session_comment",
    actorId: "guest_waiz",
    actorName: "Waiz",
    sessionId: "sess-77b0e2",
    anchorId: "sess-77b0e2",
    sessionTitle: "We need to find issues related to our terminal",
    excerpt: "This is a nice prompt — the repro steps made it easy to follow.",
    createdAt: at(1, 16),
  }),
  entry("n3", {
    kind: "artifact_reply",
    actorId: "usr_sam",
    excerpt: "Agreed, let's keep the 2px ring and drop the shadow.",
    createdAt: at(3, 11),
    readAt: at(3, 12),
  }),
  entry("n4", {
    kind: "artifact_session_comment",
    actorId: "usr_mira",
    sessionTitle: null,
    excerpt: "",
    createdAt: at(3, 9),
    readAt: at(3, 10),
  }),
  entry("n5", {
    kind: "artifact_session_comment",
    actorId: "usr_tobi",
    workspaceSlug: "atlas-docs",
    sessionTitle: "Index the current state of the codebase and adopt the design system",
    excerpt: "Hey — the index missed the new security crate.",
    createdAt: at(8, 15),
    readAt: at(8, 16),
  }),
];

const read = new Set<string>();
const isUnread = (e: InboxEntry) => !e.readAt && !read.has(e.id);

export const inboxHandlers: TypedHandlers<InboxResponses> = {
  artifacts_cloud_inbox: ({ filter }) => {
    const rows = ENTRIES.map((e) =>
      read.has(e.id) && !e.readAt ? { ...e, readAt: at(0, 0) } : e,
    ).filter((e) =>
      filter === "unread"
        ? isUnread(e)
        : filter === "mentions"
          ? e.kind === "artifact_mention"
          : true,
    );
    return { entries: rows, unread: ENTRIES.filter(isUnread).length, nextCursor: null };
  },
  artifacts_cloud_inbox_unread: () => ENTRIES.filter(isUnread).length,
  artifacts_cloud_inbox_read: ({ ids, all }) => {
    for (const e of ENTRIES) if (all || (ids as string[]).includes(e.id)) read.add(e.id);
    return null;
  },
};
