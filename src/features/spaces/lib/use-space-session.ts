import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { toBase64, fromBase64 } from "@/features/comms/lib/draft-sync";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import {
  parseServerMessage,
  spacesApi,
  type SpaceClientMessage,
  type SpaceConnState,
  type SpaceReadOnlyReason,
} from "./spaces-api";
import { subscribeSpaceBus } from "./spaces-bus";
import {
  applyAwareness,
  decodeSpaceFrame,
  SPACE_DOC_VERSION,
  frameAwareness,
  hasNewcomer,
  HELD_MERGE_AT,
  SPACE_FLUSH_TICK_MS,
  SPACE_FRAME_AWARENESS,
  SPACE_FRAME_UPDATE,
  type SpaceActor,
  type SpaceAwarenessState,
} from "./space-wire";
import { applyPageContent, applyRelayed, frameUpdate, localUndo, REMOTE } from "./space-doc";
import { useSpacesStore } from "../stores/spaces-store";

/**
 * One live Space session for one conversation: the socket lifecycle, the
 * Y.Doc for the open page, slots, resume, awareness and the roster.
 *
 * Web parity, verbatim, on every reliability decision:
 * - the Y.Doc is recreated ONLY on page switch, never on reconnect;
 * - `since` advances on `page.opened` and NOTHING else — a relayed frame
 *   never moves it, so a reconnect re-receives a little and the CRDT
 *   absorbs the overlap;
 * - local updates are sent one frame each, unthrottled (the server's 50ms
 *   tick is the throttle); while unsendable they are held and merged at 64;
 * - held updates flush AFTER the `page.opened` catch-up is applied, so the
 *   server log stays replayable;
 * - frames for a slot other than the current one are dropped (there is no
 *   `page.close` — stale subscriptions keep sending);
 * - `page.closed{evicted}` re-opens; `{deleted}` never does;
 * - `actor_ceiling` mutes ALL outgoing awareness; `archived` does not.
 */
export function useSpaceSession(convId: string) {
  const patch = useSpacesStore.getState().actions.patch;

  const [pageId, setPageId] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState<SpaceReadOnlyReason | null>(null);
  const [ready, setReady] = useState(false);
  /** Bumped on every doc change — the canvas re-reads nodes/edges off it. */
  const [revision, setRevision] = useState(0);
  const [actors, setActors] = useState<ReadonlyMap<string, SpaceActor>>(new Map());
  const [banner, setBanner] = useState<string | null>(null);

  // One doc per open page. Replaced only by openPage(); reconnects keep it.
  const docRef = useRef<Y.Doc | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const pageIdRef = useRef<string | null>(null);
  const slotRef = useRef<number | null>(null);
  const sinceRef = useRef<Map<string, number>>(new Map());
  const heldRef = useRef<Uint8Array[]>([]);
  const connRef = useRef<SpaceConnState>("disconnected");
  const readOnlyRef = useRef<SpaceReadOnlyReason | null>(null);
  const actorsRef = useRef<ReadonlyMap<string, SpaceActor>>(new Map());

  // ---- awareness publisher: 50ms trailing, patch-merged -------------------
  const mineRef = useRef<SpaceAwarenessState>({});
  const awarenessTimer = useRef<number | undefined>(undefined);

  const sendAwarenessNow = useCallback(() => {
    awarenessTimer.current = undefined;
    const slot = slotRef.current;
    if (slot === null || connRef.current !== "open") return;
    // The silence rule: a view-only seat sends NO awareness at all.
    if (readOnlyRef.current === "actor_ceiling") return;
    const s = useCommsStore.getState();
    const meId = s.me;
    const name = s.members.find((m) => m.id === meId)?.name;
    const state: SpaceAwarenessState = { ...mineRef.current };
    if (name) state.name = name;
    void spacesApi.sendBinary(convId, toBase64(frameAwareness(slot, state))).catch(() => {});
  }, [convId]);

  const publishAwareness = useCallback(
    (patchState: Partial<SpaceAwarenessState>) => {
      mineRef.current = { ...mineRef.current, ...patchState };
      if (awarenessTimer.current === undefined) {
        awarenessTimer.current = window.setTimeout(sendAwarenessNow, SPACE_FLUSH_TICK_MS);
      }
    },
    [sendAwarenessNow],
  );

  // ---- outbound doc updates ----------------------------------------------
  // Batched on a short timer, MERGED: a local drag produces one Y update per
  // pointermove, and an invoke per mousemove is a bridge round-trip the web
  // client (raw ws.send) never pays. ~33ms keeps a drag visually live for
  // peers (the server fans out on its own 50ms tick anyway) at a fraction of
  // the IPC. Yjs merge keeps it one frame on the wire.
  const outboundRef = useRef<Uint8Array[]>([]);
  const outboundTimer = useRef<number | undefined>(undefined);

  const flushOutbound = useCallback(() => {
    outboundTimer.current = undefined;
    const batch = outboundRef.current;
    if (batch.length === 0) return;
    outboundRef.current = [];
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    const slot = slotRef.current;
    if (slot !== null && connRef.current === "open") {
      void spacesApi.sendBinary(convId, toBase64(frameUpdate(slot, merged))).catch(() => {});
    } else {
      // The socket went away between enqueue and flush: hold, merged.
      heldRef.current.push(merged);
      if (heldRef.current.length >= HELD_MERGE_AT) {
        heldRef.current = [Y.mergeUpdates(heldRef.current)];
      }
    }
  }, [convId]);

  const relayUpdate = useCallback(
    (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      if (slotRef.current !== null && connRef.current === "open") {
        outboundRef.current.push(update);
        if (outboundTimer.current === undefined) {
          outboundTimer.current = window.setTimeout(flushOutbound, 33);
        }
        return;
      }
      // Offline: hold, and collapse at the web's threshold so a long
      // disconnect stays one catch-up update.
      heldRef.current.push(update);
      if (heldRef.current.length >= HELD_MERGE_AT) {
        heldRef.current = [Y.mergeUpdates(heldRef.current)];
      }
    },
    [flushOutbound],
  );

  // One repaint per animation frame, however many updates land inside it —
  // a remote drag delivers batches at ~20Hz and a local one at pointermove
  // rate, and each `revision` bump re-reads the whole doc in the canvas.
  // The timeout backstop covers a hidden window, where rAF never fires.
  const repaintScheduled = useRef(false);
  const scheduleRepaint = useCallback(() => {
    if (repaintScheduled.current) return;
    repaintScheduled.current = true;
    const bump = () => {
      repaintScheduled.current = false;
      setRevision((r) => r + 1);
    };
    if (document.visibilityState === "visible") requestAnimationFrame(bump);
    else window.setTimeout(bump, 100);
  }, []);

  const attachDoc = useCallback(
    (doc: Y.Doc) => {
      docRef.current?.destroy();
      undoRef.current?.destroy();
      docRef.current = doc;
      undoRef.current = localUndo(doc);
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        relayUpdate(update, origin);
        scheduleRepaint();
      });
    },
    [relayUpdate, scheduleRepaint],
  );

  const requestPage = useCallback(
    (id: string) => {
      const since = sinceRef.current.get(id);
      const frame: SpaceClientMessage =
        since === undefined
          ? { t: "page.open", page_id: id }
          : { t: "page.open", page_id: id, since };
      void spacesApi.sendControl(convId, frame).catch(() => {});
    },
    [convId],
  );

  /** Switch pages: fresh doc, fresh roster, tell the server. */
  const openPage = useCallback(
    (id: string) => {
      if (pageIdRef.current === id) return;
      // The tail of an edit must go out on the OLD page's slot.
      flushOutbound();
      pageIdRef.current = id;
      slotRef.current = null;
      heldRef.current = [];
      sinceRef.current.delete(id); // fresh doc ⇒ a stale `since` would gap it
      setPageId(id);
      setReady(false);
      setActors(new Map());
      actorsRef.current = new Map();
      attachDoc(new Y.Doc());
      requestPage(id);
      void spacesApi.sendControl(convId, { t: "page.active", page_id: id }).catch(() => {});
    },
    [attachDoc, convId, flushOutbound, requestPage],
  );

  // ---- inbound ------------------------------------------------------------
  useEffect(() => {
    const off = subscribeSpaceBus(convId, (ev) => {
      if (ev.kind === "connection") {
        connRef.current = ev.state;
        patch(convId, { connection: ev.state });
        if (ev.state !== "open") {
          // Presence is the socket; a dead socket is an empty room.
          setActors(new Map());
          actorsRef.current = new Map();
        }
        return;
      }

      if (ev.kind === "control") {
        const msg = parseServerMessage(ev.frame);
        if (msg === null) return; // a newer server's frame — dropped, not fatal
        switch (msg.t) {
          case "space.hello": {
            patch(convId, {
              pages: msg.pages,
              archived: msg.archived,
              stale: msg.doc_version > SPACE_DOC_VERSION,
              error: null,
            });
            // Reconnect: re-open the page we were on (fresh slot). First
            // hello: land on the remembered page, else the first real page.
            const current = pageIdRef.current;
            if (current !== null && msg.pages.some((p) => p.id === current)) {
              requestPage(current);
            } else {
              const landing =
                (msg.active_page_id !== null &&
                msg.pages.some((p) => p.id === msg.active_page_id && p.kind === "page")
                  ? msg.active_page_id
                  : null) ??
                msg.pages.find((p) => p.kind === "page")?.id ??
                null;
              if (landing !== null) openPage(landing);
            }
            break;
          }
          case "page.opened": {
            if (msg.page_id !== pageIdRef.current) break;
            slotRef.current = msg.slot;
            sinceRef.current.set(msg.page_id, msg.index);
            readOnlyRef.current = msg.read_only;
            setReadOnly(msg.read_only);
            const doc = docRef.current;
            if (doc) {
              applyPageContent(doc, msg);
              // The reconnect catch-up: held edits go AFTER the server's,
              // so its log stays replayable.
              if (heldRef.current.length > 0 && msg.read_only === null) {
                const merged = Y.mergeUpdates(heldRef.current);
                heldRef.current = [];
                void spacesApi
                  .sendBinary(convId, toBase64(frameUpdate(msg.slot, merged)))
                  .catch(() => {});
              }
            }
            setReady(true);
            // Awareness is never replayed: announce ourselves.
            if (msg.read_only !== "actor_ceiling") publishAwareness({});
            break;
          }
          case "page.tree": {
            patch(convId, { pages: msg.pages });
            // The open page can vanish under us (deleted elsewhere).
            const current = pageIdRef.current;
            if (current !== null && !msg.pages.some((p) => p.id === current)) {
              const fallback = msg.pages.find((p) => p.kind === "page")?.id ?? null;
              if (fallback !== null) openPage(fallback);
            }
            break;
          }
          case "page.created":
            break; // the accompanying page.tree carries the row
          case "page.closed": {
            // Only the LRU eviction re-opens; a deletion is final and the
            // page.tree handler already moved us.
            if (msg.reason === "evicted" && msg.page_id === pageIdRef.current) {
              slotRef.current = null;
              requestPage(msg.page_id);
            }
            break;
          }
          case "space.access": {
            patch(convId, { archived: msg.archived });
            break;
          }
          case "error": {
            const detail = msg.error.detail as { reconnect?: boolean } | undefined;
            if (detail?.reconnect === true) {
              // Fresh slots by instruction: drop the socket and redial.
              slotRef.current = null;
              void spacesApi.cycle(convId).catch(() => {});
            } else {
              setBanner(msg.error.message || msg.error.code);
            }
            break;
          }
        }
        return;
      }

      // Binary. Route by slot — a frame for a stale slot is dropped.
      const bytes = fromBase64(ev.data);
      if (bytes === null) return;
      const frame = decodeSpaceFrame(bytes);
      if (frame === null || frame.slot !== slotRef.current) return;
      if (frame.type === SPACE_FRAME_UPDATE) {
        const doc = docRef.current;
        if (doc) applyRelayed(doc, frame.payload);
      } else if (frame.type === SPACE_FRAME_AWARENESS) {
        const before = actorsRef.current;
        const after = applyAwareness(before, frame.payload);
        if (after !== before) {
          actorsRef.current = after;
          setActors(after);
          // Answer an arrival with a state of one's own — a still mouse
          // would otherwise be invisible indefinitely.
          if (hasNewcomer(before, after) && readOnlyRef.current !== "actor_ceiling") {
            publishAwareness({});
          }
        }
      }
    });
    return off;
  }, [convId, openPage, patch, publishAwareness, requestPage]);

  // ---- lifecycle ----------------------------------------------------------
  useEffect(() => {
    // REST pre-flight first: it maps 401/403/404 to words, and lazily
    // creates the Space — the socket's hello then finds it existing.
    spacesApi
      .summary(convId)
      .then((summary) => {
        useSpacesStore.getState().actions.adoptSummary(convId, summary);
      })
      .catch((e) => {
        patch(convId, { error: typeof e === "string" ? e : "This Space could not be opened." });
      });
    spacesApi.connect(convId).catch((e) => {
      console.error("spaces: connect failed:", convId, e);
    });
    return () => {
      // A mid-drag edit must not die with the unmount.
      flushOutbound();
      if (outboundTimer.current !== undefined) window.clearTimeout(outboundTimer.current);
      // Cursor off the canvas for everyone else, then the socket down.
      void spacesApi.disconnect(convId).catch(() => {});
      docRef.current?.destroy();
      undoRef.current?.destroy();
      docRef.current = null;
      undoRef.current = null;
      pageIdRef.current = null;
      slotRef.current = null;
      if (awarenessTimer.current !== undefined) window.clearTimeout(awarenessTimer.current);
    };
  }, [convId, flushOutbound, patch]);

  // ---- tree actions (non-optimistic; the server broadcasts the tree) ------
  const send = useCallback(
    (message: SpaceClientMessage) => {
      void spacesApi.sendControl(convId, message).catch(() => {});
    },
    [convId],
  );

  const meta = useSpacesStore((s) => s.byConv[convId]);

  return useMemo(
    () => ({
      pageId,
      ready,
      revision,
      actors,
      readOnly,
      banner,
      dismissBanner: () => setBanner(null),
      meta,
      doc: docRef,
      undo: undoRef,
      openPage,
      publishAwareness,
      createPage: (opts: { kind?: "page" | "folder"; parent_id?: string | null }) =>
        send({ t: "page.create", ...opts }),
      renamePage: (id: string, fields: { name?: string; icon?: string | null }) =>
        send({ t: "page.rename", page_id: id, ...fields }),
      movePage: (id: string, parentId: string | null, index: number) =>
        send({ t: "page.move", page_id: id, parent_id: parentId, index }),
      deletePage: (id: string) => send({ t: "page.delete", page_id: id }),
    }),
    [pageId, ready, revision, actors, readOnly, banner, meta, openPage, publishAwareness, send],
  );
}

export type SpaceSession = ReturnType<typeof useSpaceSession>;
