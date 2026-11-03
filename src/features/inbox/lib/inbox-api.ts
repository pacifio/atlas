// The Organisation inbox over IPC (`src-tauri/src/commands/artifacts_cloud.rs`):
// the signed-in person's mentions, replies and comments on their Sessions in
// the active synced Organisation — the web app's /inbox, on the same ingest
// doors. Rust holds the token and the Organisation; nothing here decides.

import { invoke } from "@tauri-apps/api/core";

/** Why an entry is in the inbox (`InboxKind` on the wire). */
export type InboxKind = "artifact_mention" | "artifact_reply" | "artifact_session_comment";

/** The segmented control's three views. */
export type InboxFilter = "all" | "unread" | "mentions";

/** Mirror of Rust `atlas_artifacts::InboxEntry`. */
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  orgId: string;
  /** The server Project ("workspace") the Session belongs to. */
  workspaceId: string;
  workspaceSlug: string;
  sessionId: string;
  sessionTitle: string | null;
  commentId: string;
  anchorKind: "session" | "message" | "tool_call" | "checkpoint" | "thread_range";
  /** The row the comment hangs off; the Session's own id for `session`. */
  anchorId: string;
  actorId: string;
  /** Set for a guest only — a member's name comes from the directory. */
  actorName: string | null;
  /** The comment, shortened; empty once it was deleted. */
  excerpt: string;
  createdAt: string;
  /** `null` while unread. */
  readAt: string | null;
  /** The web app's deep link, relative to its origin. */
  path: string;
}

/** Mirror of Rust `atlas_artifacts::InboxPage`. */
export interface InboxPage {
  entries: InboxEntry[];
  /** Unread across the Organisation — not this page's share. */
  unread: number;
  nextCursor: string | null;
}

export const inbox = {
  page: (filter: InboxFilter, cursor: string | null = null) =>
    invoke<InboxPage>("artifacts_cloud_inbox", { filter, cursor }),
  unread: () => invoke<number>("artifacts_cloud_inbox_unread"),
  markRead: (ids: string[]) => invoke<void>("artifacts_cloud_inbox_read", { ids, all: false }),
  markAllRead: () => invoke<void>("artifacts_cloud_inbox_read", { ids: [], all: true }),
};
