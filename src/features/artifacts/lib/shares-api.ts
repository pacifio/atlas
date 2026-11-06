/**
 * Public share links on a Session (ATL-328).
 *
 * A link lets somebody outside the Organisation read one Session without an
 * account. The door is layered — an unguessable slug, a rate limit, a bot
 * challenge, then a password where there is one — and all of that is the
 * server's; this is only the owner's side of it: is there a link, make one,
 * take it down.
 *
 * **A slug is a credential.** It is the whole of what protects somebody's
 * record, so nothing here caches one to disk and nothing logs one.
 */

import { invoke } from "@tauri-apps/api/core";

/** One share, as its owner sees it. The password is never among the fields —
 *  only whether there is one. */
export interface ArtifactShare {
  id: string;
  /** `session` for one run, `workspace` for a whole Project's worth. */
  scope: string;
  workspaceId: string;
  sessionId: string | null;
  /** The unguessable part of the public address. */
  slug: string;
  hasPassword: boolean;
  commentsEnabled: boolean;
  expiresAt: string | null;
  /** Set once revoked; a revoked link is refused immediately. */
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export const shares = {
  /** The Session's live link, or `null` — which also covers "not on the
   *  server", because both read the same to the sheet. */
  forSession: (projectId: string, sessionId: string) =>
    invoke<ArtifactShare | null>("artifacts_cloud_session_share", { projectId, sessionId }),

  /** Publish the Session. Guest commenting is off unless asked for. */
  create: (projectId: string, sessionId: string, comments: boolean) =>
    invoke<ArtifactShare>("artifacts_cloud_share_create", { projectId, sessionId, comments }),

  /** Take the link down. Tokens already issued against it stop working. */
  revoke: (projectId: string, shareId: string) =>
    invoke<void>("artifacts_cloud_share_revoke", { projectId, shareId }),

  /** The address a guest opens. */
  url: (slug: string) => invoke<string>("artifacts_cloud_share_url", { slug }),

  /** The in-app address of the Session, for people who do have an account. */
  orgUrl: (projectId: string, sessionId: string) =>
    invoke<string | null>("artifacts_cloud_session_url", { projectId, sessionId }),
};
