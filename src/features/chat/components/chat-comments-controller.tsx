/**
 * Keeps one chat pane's cloud comments current. Renders nothing.
 *
 * Mounted once per `ChatPanel`. It answers three questions and writes the
 * answers into `chat-comments-store`, where the header badge, the panel and
 * the transcript rows read them through narrow selectors:
 *
 * 1. **Is this session in the cloud?** `chat_comment_target` says so only when
 *    the Organisation is synced, the Project is bound to Cloud for it, and the
 *    session has been captured. Asked on mount, when the session binds, when a
 *    turn ends (the captured rows land at turn end), when capture announces a
 *    write, and when a comment arrives on a row the map does not know.
 * 2. **Which captured row is which chat message?** `buildAnchorMap`, rebuilt
 *    when the thread's shape changes — never per streaming chunk.
 * 3. **What are the comments?** `useSessionComments`, verbatim from the
 *    Timeline: the same watch subscription, the same realtime handler, the
 *    same post/resolve/remove.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useSessionComments } from "@/features/artifacts/lib/use-session-comments";
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";
import { isBusyAgentStatus } from "@/types/agent";

import { buildAnchorMap, structureKey, type AnchorEntry } from "../lib/comment-anchors";
import { commentToMention, linkCommentToComposer } from "../lib/comment-mentions";
import { projectPathForTab } from "../lib/tab-project";
import { useChatCommentsStore, type CommentTargetIds } from "../stores/chat-comments-store";
import { useChatStore } from "../stores/chat-store";

export interface CommentTarget extends CommentTargetIds {
  entries: AnchorEntry[];
}

/** Capture coalesces its own writes; this absorbs the board ticker's echo. */
const CAPTURE_DEBOUNCE_MS = 300;
/** The worker flushes a turn's messages after the turn ends; give it a beat. */
const TURN_END_DELAY_MS = 500;

function entriesKey(entries: AnchorEntry[]): string {
  let key = "";
  for (const e of entries) key += `${e.rowId}|${e.nativeId ?? ""};`;
  return key;
}

export function ChatCommentsController({ tabId }: { tabId: string }) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const busy = useChatStore((s) => isBusyAgentStatus(s.sessions[tabId]?.status));
  const shape = useChatStore((s) => structureKey(s.sessions[tabId]?.messages));
  const visible = useIsTabVisible(tabId);
  const { setTarget, setAnchors, setComments, clear } = useChatCommentsStore.use.actions();

  const [target, setLocalTarget] = useState<CommentTarget | null>(null);
  const targetRef = useRef<CommentTarget | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const inFlight = useRef(false);
  const again = useRef(false);

  // One resolver, serialised: a second request while one is out is folded
  // into a single re-run after it lands, so bursts of capture events cost one
  // read.
  const resolve = useRef(async () => {});
  resolve.current = async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const projectPath = projectPathForTab(tabId);
      const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
      let next: CommentTarget | null = null;
      if (projectPath && sessionId) {
        next = await invoke<CommentTarget | null>("chat_comment_target", {
          projectPath,
          nativeSessionId: sessionId,
        }).catch(() => null);
      }
      const prev = targetRef.current;
      const same =
        prev?.remoteProjectId === next?.remoteProjectId &&
        prev?.sessionId === next?.sessionId &&
        entriesKey(prev?.entries ?? []) === entriesKey(next?.entries ?? []);
      if (!same) {
        targetRef.current = next;
        setLocalTarget(next);
        setTarget(
          tabId,
          next ? { remoteProjectId: next.remoteProjectId, sessionId: next.sessionId } : null,
          next?.entries ?? [],
        );
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void resolve.current();
      }
    }
  };

  // Mount, and every time the session binds to a different agent session.
  useEffect(() => {
    void resolve.current();
  }, [tabId, acpSessionId]);

  // Turn end: the captured rows for that turn land now.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const t = setTimeout(() => void resolve.current(), TURN_END_DELAY_MS);
      wasBusy.current = busy;
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
  }, [busy]);

  // Capture wrote something (or the board ticker fired). Only a visible pane
  // pays the read; a hidden one catches up when it is shown.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = listen("atlas:capture-changed", () => {
      if (!visibleRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void resolve.current(), CAPTURE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void safeUnlistenPromise(stop);
    };
  }, []);
  useEffect(() => {
    if (visible) void resolve.current();
  }, [visible]);

  // The anchor map: chat shape × captured rows.
  useEffect(() => {
    const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
    setAnchors(tabId, buildAnchorMap(messages, target?.entries ?? []));
  }, [tabId, shape, target, setAnchors]);

  // The comments themselves. Followed only while the pane is showing: a chat
  // pane stays mounted when hidden, and every follow is a socket. The hook
  // re-lists on show, so nothing said in between is missed.
  const comments = useSessionComments(
    visible ? (target?.remoteProjectId ?? null) : null,
    visible ? (target?.sessionId ?? null) : null,
  );
  // The chat's popovers can link a comment into THIS pane's composer. Added
  // here, where the tab is known, so the Timeline's popovers (no composer of
  // their own) keep drawing no link button.
  // `actions` is memoised on its own: every row subscribes to it, and a new
  // object per comment frame would re-render all of them.
  const baseActions = comments?.actions ?? null;
  const actions = useMemo(() => {
    if (!baseActions) return null;
    const link = (comment: Parameters<typeof commentToMention>[0]) => {
      const tab = useChatCommentsStore.getState().byTab[tabId];
      const mention = tab ? commentToMention(comment, tab) : null;
      if (mention) linkCommentToComposer(tabId, mention);
    };
    return { ...baseActions, link };
  }, [baseActions, tabId]);
  const linkable = useMemo(
    () => (comments && actions ? { ...comments, actions } : null),
    [comments, actions],
  );
  useEffect(() => {
    setComments(tabId, linkable);
    if (!comments || !target) return;
    // A comment on a row the map cannot place: a turn that landed after the
    // last resolve. Ask once per change of the buckets, not per frame.
    const known = useChatCommentsStore.getState().byTab[tabId]?.anchors.chatKeyByRowId;
    for (const rowId in comments.byAnchor) {
      if (!known?.has(rowId)) {
        void resolve.current();
        break;
      }
    }
  }, [tabId, comments, linkable, target, setComments]);

  // Clearing the store entry must also forget the target this instance last
  // pushed: a hidden pane (an inactive center tab) runs its effect cleanups but
  // keeps its refs, so on show `resolve` would find the same target, skip
  // `setTarget`, and leave the store without one — no badge, no faces, no link.
  useEffect(
    () => () => {
      targetRef.current = null;
      clear(tabId);
    },
    [tabId, clear],
  );

  return null;
}
