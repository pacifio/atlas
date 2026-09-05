import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { comms } from "./comms-api";
import { subscribeDraftBus } from "./draft-bus";
import {
  applyContent,
  AWARENESS_HEARTBEAT_MS,
  AWARENESS_INTERVAL_MS,
  AWARENESS_TTL_MS,
  decodeAwareness,
  encodeAwareness,
  PROMPT_TEXT_KEY,
  REMOTE,
  toBase64,
  UPDATE_DEBOUNCE_MS,
} from "./draft-sync";
import { useCommsStore } from "../stores/comms-store";
import type { PromptDraft } from "../types";

export interface DraftPeer {
  userId: string;
  cursor: number;
  at: number;
}

/**
 * One live editing session for one draft: the Y.Doc, the relay to and from
 * the socket, and the peers map.
 *
 * The reliability model is web parity, verbatim: local updates are batched
 * at 100ms and MERGED; a batch that cannot send (no socket) stays merged in
 * `unsent` and re-flushes after the next `draft.opened` — which a reconnect
 * always produces, because this hook re-opens on every disconnected→open
 * edge (the subscription is per-socket). Losing an awareness frame is
 * meaningless; the heartbeat restates it.
 */
export function useDraftSession(draft: PromptDraft) {
  const draftId = draft.id;
  const me = useCommsStore.use.me();

  const doc = useMemo(() => new Y.Doc(), []);
  const ytext = useMemo(() => doc.getText(PROMPT_TEXT_KEY), [doc]);

  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState<PromptDraft>(draft);
  const [peers, setPeers] = useState<Record<string, DraftPeer>>({});

  const pending = useRef<Uint8Array[]>([]);
  const unsent = useRef<Uint8Array[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);
  const lastAwareness = useRef(0);

  // ---- outbound: local edits → merged base64 batches ----------------------
  useEffect(() => {
    const flush = () => {
      flushTimer.current = undefined;
      const batch = [...unsent.current, ...pending.current];
      pending.current = [];
      if (batch.length === 0) return;
      const merged = Y.mergeUpdates(batch);
      // The invoke itself always resolves (Rust drops silently with no
      // socket), so retention is keyed on CONNECTION state, the same signal
      // the web client keys on.
      const open = useCommsStore.getState().connection.state === "open";
      if (open) {
        void comms.draftUpdate(draftId, toBase64(merged)).catch(() => {
          unsent.current = [merged];
        });
        unsent.current = [];
      } else {
        // Keep it MERGED — a long disconnect stays one catch-up update.
        unsent.current = [merged];
      }
    };

    const relay = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      pending.current.push(update);
      if (flushTimer.current === undefined) {
        flushTimer.current = window.setTimeout(flush, UPDATE_DEBOUNCE_MS);
      }
    };
    doc.on("update", relay);
    return () => {
      doc.off("update", relay);
      if (flushTimer.current !== undefined) window.clearTimeout(flushTimer.current);
      // A mid-word edit must not die with the unmount.
      flush();
    };
  }, [doc, draftId]);

  // ---- inbound: bus → doc / peers ----------------------------------------
  useEffect(() => {
    const off = subscribeDraftBus((ev) => {
      if (ev.draft_id !== draftId) return;
      if (ev.kind === "opened") {
        applyContent(doc, ev.snapshot, ev.updates);
        setMeta(ev.draft);
        setReady(true);
        // The reconnect catch-up: anything held while offline goes now.
        if (unsent.current.length > 0) {
          const merged = Y.mergeUpdates(unsent.current);
          unsent.current = [];
          void comms.draftUpdate(draftId, toBase64(merged)).catch(() => {
            unsent.current = [merged];
          });
        }
      } else if (ev.kind === "update") {
        const bytes = ev.update;
        try {
          const decoded = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
          Y.applyUpdate(doc, decoded, REMOTE);
        } catch (e) {
          console.warn("comms: malformed draft update dropped:", e);
        }
      } else {
        if (ev.user_id === me) return;
        const state = decodeAwareness(ev.state);
        if (state) {
          setPeers((current) => ({
            ...current,
            [ev.user_id]: { userId: ev.user_id, cursor: state.cursor, at: Date.now() },
          }));
        }
      }
    });
    return off;
  }, [doc, draftId, me]);

  // ---- open + reopen on reconnect ----------------------------------------
  useEffect(() => {
    // Surfaced, not void-dropped: on a stale binary this invoke REJECTS
    // (command not registered), and an unhandled rejection here looked like
    // "clicked and nothing happened".
    comms.draftOpen(draftId).catch((e) => {
      console.error("comms: draft open failed:", draftId, e);
    });
    let wasOpen = useCommsStore.getState().connection.state === "open";
    const unsub = useCommsStore.subscribe((s) => {
      const open = s.connection.state === "open";
      if (open && !wasOpen) {
        comms.draftOpen(draftId).catch((e) => {
          console.error("comms: draft re-open failed:", draftId, e);
        });
      }
      wasOpen = open;
    });
    return unsub;
  }, [draftId]);

  // ---- awareness out: throttled publisher + heartbeat ---------------------
  const cursorRef = useRef(0);
  const publishCursor = useMemo(() => {
    return (offset: number, force = false) => {
      cursorRef.current = offset;
      if (meta.sent_at !== null) return;
      const now = Date.now();
      if (!force && now - lastAwareness.current < AWARENESS_INTERVAL_MS) return;
      lastAwareness.current = now;
      void comms.draftAwareness(draftId, encodeAwareness({ cursor: offset })).catch(() => {});
    };
  }, [draftId, meta.sent_at]);

  useEffect(() => {
    const beat = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      publishCursor(cursorRef.current, true);
    }, AWARENESS_HEARTBEAT_MS);
    return () => window.clearInterval(beat);
  }, [publishCursor]);

  // ---- peer expiry: no leave frame exists, age them out -------------------
  useEffect(() => {
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - AWARENESS_TTL_MS;
      setPeers((current) => {
        const alive = Object.fromEntries(Object.entries(current).filter(([, p]) => p.at >= cutoff));
        return Object.keys(alive).length === Object.keys(current).length ? current : alive;
      });
    }, 5_000);
    return () => window.clearInterval(sweep);
  }, []);

  useEffect(() => () => doc.destroy(), [doc]);

  return { doc, ytext, ready, meta, peers, publishCursor };
}
