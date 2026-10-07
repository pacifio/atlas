/**
 * One open Session's comments, kept current.
 *
 * Loads once when a shared Session opens, then follows the realtime channel.
 * Returns `null` for a Session that is not on the server, which is what hides
 * every comment affordance — there is no anchor to attach one to.
 *
 * # Why the socket and not a poll
 *
 * The server sends **one** frame shape for post, edit, resolve and delete, so a
 * single handler covers all four and the thread stays right without refetching.
 * A poll would also have to re-read the whole list every time: the comments
 * endpoint is unpaged.
 *
 * # No optimism, on purpose
 *
 * A posted comment appears when the server has it, because the server is what
 * stamps the author, parses the mentions, and can refuse. Painting one
 * optimistically — with no offline queue to hold it — would be a lie that loses
 * the text the moment the request failed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";

import type { RowComments } from "../components/session-detail";
import {
  applyComment,
  comments as api,
  EMPTY_THREADS,
  type AnchorKind,
  type Comment,
  type CommentThreads,
} from "./comments-api";
import { queueFollow, queueUnfollow } from "./watch-queue";

/** The window channel the cloud bridge emits on. */
const ARTIFACTS_EVENT = "atlas:artifacts-cloud";

type WireEvent =
  | { kind: "boardChanged" }
  | { kind: "entryUpsert"; sessionId: string; change: string; entry: unknown }
  | { kind: "commentUpsert"; sessionId: string; comment: Comment }
  | { kind: "presence"; projectId: string; online: string[] }
  | { kind: "revoked"; projectId: string }
  | { kind: "resync" };

export function useSessionComments(
  /** The **server** Project id. `null` for a Session that is not shared. */
  remoteProjectId: string | null,
  sessionId: string | null,
): RowComments | null {
  // One roster for every byline, mention and avatar stack in the pane. Resolved
  // here rather than per comment: the hook is stale-while-revalidate, so the
  // cost is one request however many surfaces read it.
  const directory = useOrgDirectory();
  const [threads, setThreads] = useState<CommentThreads>(EMPTY_THREADS);

  const shared = remoteProjectId !== null && sessionId !== null;

  // A different Session starts empty, in the same render: the previous one's
  // threads would otherwise show under it (badge, panel, pills) until its own
  // list answered — indefinitely on a hung or offline read.
  const identity = shared ? `${remoteProjectId}\u0000${sessionId}` : null;
  const [threadsFor, setThreadsFor] = useState(identity);
  if (threadsFor !== identity) {
    setThreadsFor(identity);
    setThreads(EMPTY_THREADS);
  }

  // Follow this Session. Rust opens a socket subscribed to exactly it (or
  // shares the one another surface already holds — the Timeline and a chat
  // tab on one Session are one socket), and closes it when the last watcher
  // lets go. Dialled for any Project in the Organisation, bound here or not.
  //
  // Through one queue, so the unfollow of a cleanup can never overtake the
  // follow of the next mount — see `watch-queue.ts`.
  useEffect(() => {
    if (!shared) return;
    void queueFollow(remoteProjectId, sessionId);
    return () => {
      void queueUnfollow(remoteProjectId, sessionId);
    };
  }, [shared, remoteProjectId, sessionId]);

  const load = useCallback(() => {
    if (!shared) {
      setThreads(EMPTY_THREADS);
      return;
    }
    let live = true;
    void api
      .list(remoteProjectId, sessionId)
      .then((next) => {
        if (live) setThreads(next);
      })
      // A failed read leaves no comments rather than an error banner over a
      // Session that is otherwise perfectly readable. The realtime channel
      // still fills them in if it connects.
      .catch(() => {
        if (live) setThreads(EMPTY_THREADS);
      });
    return () => {
      live = false;
    };
  }, [shared, remoteProjectId, sessionId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!shared) return;
    const stop = listen<WireEvent>(ARTIFACTS_EVENT, (event) => {
      const payload = event.payload;
      if (payload.kind === "commentUpsert") {
        // Frames reach every socket on the Project, not only this Session's.
        if (payload.sessionId !== sessionId) return;
        setThreads((current) => applyComment(current, payload.comment));
        return;
      }
      // We fell behind and frames were dropped, so local state has a gap it
      // cannot see. Re-read rather than carrying it.
      if (payload.kind === "resync") load();
    });
    return () => safeUnlistenPromise(stop);
  }, [shared, sessionId, load]);

  const actions = useMemo(
    () => ({
      post: async (
        anchorKind: AnchorKind,
        anchorId: string,
        body: string,
        parentId: string | null,
      ) => {
        if (!shared) return;
        const posted = await api.create(
          remoteProjectId,
          sessionId,
          anchorKind,
          anchorId,
          body,
          parentId,
        );
        // Apply the answer directly rather than waiting for the echo: the
        // socket frame is the same comment, and `applyComment` is keyed by id,
        // so whichever lands second is a no-op replacement.
        setThreads((current) => applyComment(current, posted));
      },
      // Author only — the server refuses anyone else (`forbidden`), and the
      // thread only offers it on your own comments. It stamps `editedAt`,
      // which is what draws the "edited" marker.
      edit: async (commentId: string, body: string) => {
        if (!shared) return;
        const updated = await api.update(remoteProjectId, sessionId, commentId, { body });
        setThreads((current) => applyComment(current, updated));
      },
      resolve: async (commentId: string, resolved: boolean) => {
        if (!shared) return;
        const updated = await api.update(remoteProjectId, sessionId, commentId, { resolved });
        setThreads((current) => applyComment(current, updated));
      },
      remove: async (commentId: string) => {
        if (!shared) return;
        const removed = await api.remove(remoteProjectId, sessionId, commentId);
        setThreads((current) => applyComment(current, removed));
      },
    }),
    [shared, remoteProjectId, sessionId],
  );

  return useMemo(
    () =>
      shared
        ? {
            byAnchor: threads.byAnchor,
            session: threads.session,
            actions,
            directory,
          }
        : null,
    [shared, threads, actions, directory],
  );
}
