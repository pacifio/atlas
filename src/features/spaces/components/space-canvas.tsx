import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  addEdge as docAddEdge,
  addNode as docAddNode,
  deleteEdge as docDeleteEdge,
  deleteNode as docDeleteNode,
  moveNode as docMoveNode,
  readEdges,
  readNodes,
  SPACE_NODE_DEFAULT_SIZE,
  type SpaceAnchor,
  type SpaceShapeType,
} from "../lib/space-doc";
import { selectionColours } from "../lib/space-wire";
import { spacesApi } from "../lib/spaces-api";
import type { SpaceDock } from "../lib/dock";
import type { SpaceSession } from "../lib/use-space-session";
import { SpaceCanvasContext, type SpaceCanvasCtx } from "./space-canvas-ctx";
import { SPACE_NODE_TYPES } from "./space-nodes";
import { SpaceActionPill, SpaceHeaderPill, type SyncState } from "./space-chrome";
import { SpaceCursors } from "./space-cursors";
import { SpaceToolbar, type SpaceTool } from "./space-toolbar";

/**
 * The realtime canvas surface. The Y.Doc is the state: nodes and edges are
 * re-read on every `session.revision` bump, and local edits write straight
 * back into it — local and remote changes reach the screen by one route.
 */

/** Local handle ids (NodeHandles: t/r/b/l) ↔ contract anchors (n/e/s/w). */
const HANDLE_TO_ANCHOR: Record<string, SpaceAnchor> = { t: "n", r: "e", b: "s", l: "w" };
const ANCHOR_TO_HANDLE: Record<SpaceAnchor, string> = { n: "t", e: "r", s: "b", w: "l" };

export interface SpaceCanvasProps {
  convId: string;
  session: SpaceSession;
  pagesOpen: boolean;
  onTogglePages: () => void;
  dock: SpaceDock;
  onDock: (dock: SpaceDock) => void;
  /** Newer-dialect document (doc_version above ours): render, never write. */
  forceReadOnly?: boolean;
}

export function SpaceCanvas(props: SpaceCanvasProps) {
  return (
    <ReactFlowProvider>
      <SpaceSurface {...props} />
    </ReactFlowProvider>
  );
}

function SpaceSurface({
  convId,
  session,
  pagesOpen,
  onTogglePages,
  dock,
  onDock,
  forceReadOnly = false,
}: SpaceCanvasProps) {
  const { revision, actors, readOnly, ready } = session;
  const editable = readOnly === null && ready && !forceReadOnly;
  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [activeTool, setActiveTool] = useState<SpaceTool>("select");
  const [uploading, setUploading] = useState(false);
  const armed = activeTool === "note" || activeTool === "text" || activeTool.startsWith("shape:");

  // Deps deliberately EXCLUDE `session` (a new object per revision): the
  // context reaches every node component, and its identity churning at drag
  // rate would defeat every memo below it. `session.doc` is a stable ref.
  const docRef = session.doc;
  const ctx = useMemo<SpaceCanvasCtx>(
    () => ({
      convId,
      doc: () => docRef.current,
      readOnly: !editable,
    }),
    [convId, docRef, editable],
  );

  // ---- doc → xyflow -------------------------------------------------------
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const peerOutlines = useMemo(() => selectionColours(actors), [actors]);

  // Node objects are IDENTITY-CACHED per id: a drag changes one node's row,
  // and the other ~199 must keep their references so their memo'd components
  // hold. The signature covers everything the produced object encodes; a
  // stale-signature hit returns the exact previous object.
  const nodeCache = useRef<Map<string, { sig: string; node: Node }>>(new Map());
  const rfNodes = useMemo<Node[]>(() => {
    void revision; // the dependency that makes the doc re-read
    const doc = session.doc.current;
    if (!doc) return [];
    const cache = nodeCache.current;
    const seen = new Set<string>();
    const out = readNodes(doc).map((n) => {
      seen.add(n.id);
      const outline = peerOutlines.get(n.id);
      const sig = [
        n.kind,
        n.x,
        n.y,
        n.width,
        n.height,
        n.title,
        n.body,
        n.text,
        n.color,
        n.shapeType,
        n.mediaKind,
        n.contentHash,
        n.mime,
        selectedSet.has(n.id),
        editable,
        outline ?? "",
      ].join("\u0000");
      const hit = cache.get(n.id);
      if (hit && hit.sig === sig) return hit.node;
      const node: Node = {
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        selected: selectedSet.has(n.id),
        draggable: editable,
        style: outline
          ? { outline: `2px solid ${outline}`, outlineOffset: 2, borderRadius: 6 }
          : undefined,
        data: {
          title: n.title,
          body: n.body,
          text: n.text,
          color: n.color,
          shapeType: n.shapeType,
          mediaKind: n.mediaKind,
          contentHash: n.contentHash,
          mime: n.mime,
        },
      };
      cache.set(n.id, { sig, node });
      return node;
    });
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return out;
  }, [revision, session.doc, selectedSet, peerOutlines, editable]);

  const rfEdges = useMemo<Edge[]>(() => {
    void revision;
    const doc = session.doc.current;
    if (!doc) return [];
    return readEdges(doc).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: ANCHOR_TO_HANDLE[e.sourceAnchor],
      targetHandle: ANCHOR_TO_HANDLE[e.targetAnchor],
      type: "smoothstep",
      style: { stroke: e.color ?? "rgba(255,255,255,0.25)", strokeWidth: 1.5 },
    }));
  }, [revision, session.doc]);

  // ---- xyflow → doc -------------------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const doc = session.doc.current;
      let selChanged = false;
      const sel = new Set(selectedIds);
      for (const c of changes) {
        if (c.type === "position" && c.position && doc && editable) {
          // Web parity: written on every position change, not on drop — the
          // server's 50ms flush tick is the throttle.
          docMoveNode(doc, c.id, c.position);
        } else if (c.type === "remove" && doc && editable) {
          docDeleteNode(doc, c.id);
        } else if (c.type === "select") {
          selChanged = true;
          if (c.selected) sel.add(c.id);
          else sel.delete(c.id);
        }
        // `dimensions` is deliberately ignored here: sizes are written by the
        // NodeResizer callback, and a measurement pass must never LWW a size.
      }
      if (selChanged) {
        const ids = [...sel];
        setSelectedIds(ids);
        session.publishAwareness({ selection: ids });
      }
    },
    [session, selectedIds, editable],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const doc = session.doc.current;
      if (!doc || !editable) return;
      for (const c of changes) {
        if (c.type === "remove") docDeleteEdge(doc, c.id);
      }
    },
    [session, editable],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const doc = session.doc.current;
      if (!doc || !editable || !c.source || !c.target) return;
      docAddEdge(doc, {
        source: c.source,
        target: c.target,
        sourceAnchor: c.sourceHandle ? HANDLE_TO_ANCHOR[c.sourceHandle] : undefined,
        targetAnchor: c.targetHandle ? HANDLE_TO_ANCHOR[c.targetHandle] : undefined,
      });
    },
    [session, editable],
  );

  // ---- presence out -------------------------------------------------------
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      session.publishAwareness({ cursor: at });
    },
    [rf, session],
  );
  const onPointerLeave = useCallback(() => {
    session.publishAwareness({ cursor: null });
  }, [session]);
  const onMove = useCallback(
    (_: unknown, vp: { x: number; y: number; zoom: number }) => {
      session.publishAwareness({ viewport: vp });
    },
    [session],
  );

  // ---- create: drag-to-create overlay (the local canvas's recipe) ---------
  const [preview, setPreview] = useState<{
    left: number;
    top: number;
    w: number;
    h: number;
  } | null>(null);
  const dragStart = useRef<{ sx: number; sy: number; fx: number; fy: number } | null>(null);

  const overlayDown = useCallback(
    (e: React.PointerEvent) => {
      const wrap = wrapperRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      dragStart.current = { sx: e.clientX - r.left, sy: e.clientY - r.top, fx: flow.x, fy: flow.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setPreview(null);
    },
    [rf],
  );

  const overlayMove = useCallback((e: React.PointerEvent) => {
    const st = dragStart.current;
    const wrap = wrapperRef.current;
    if (!st || !wrap) return;
    const r = wrap.getBoundingClientRect();
    let dx = e.clientX - r.left - st.sx;
    let dy = e.clientY - r.top - st.sy;
    if (e.shiftKey) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * s;
      dy = (dy < 0 ? -1 : 1) * s;
    }
    setPreview({
      left: Math.min(st.sx, st.sx + dx),
      top: Math.min(st.sy, st.sy + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
    });
  }, []);

  const overlayUp = useCallback(
    (e: React.PointerEvent) => {
      const st = dragStart.current;
      dragStart.current = null;
      setPreview(null);
      const doc = session.doc.current;
      if (!st || !doc || !editable) return;
      const end = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      let dx = end.x - st.fx;
      let dy = end.y - st.fy;
      if (e.shiftKey) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (dx < 0 ? -1 : 1) * s;
        dy = (dy < 0 ? -1 : 1) * s;
      }
      const x = Math.min(st.fx, st.fx + dx);
      const y = Math.min(st.fy, st.fy + dy);
      const w = Math.abs(dx);
      const h = Math.abs(dy);
      const tiny = w < 8 && h < 8; // a click → default size
      if (activeTool.startsWith("shape:")) {
        const shapeType = activeTool.slice(6) as SpaceShapeType;
        docAddNode(doc, {
          kind: "shape",
          shapeType,
          x: tiny ? st.fx - 80 : x,
          y: tiny ? st.fy - 50 : y,
          width: tiny ? 160 : Math.max(40, Math.round(w)),
          height: tiny ? 100 : Math.max(40, Math.round(h)),
        });
      } else if (activeTool === "note") {
        docAddNode(doc, {
          kind: "note",
          x: st.fx - SPACE_NODE_DEFAULT_SIZE.width / 2,
          y: st.fy - SPACE_NODE_DEFAULT_SIZE.height / 2,
        });
      } else if (activeTool === "text") {
        docAddNode(doc, { kind: "text", x: st.fx, y: st.fy, width: 240, height: 80 });
      } else if (activeTool === "group") {
        docAddNode(doc, {
          kind: "group",
          x: tiny ? st.fx - 160 : x,
          y: tiny ? st.fy - 100 : y,
          width: tiny ? 320 : Math.max(120, Math.round(w)),
          height: tiny ? 200 : Math.max(80, Math.round(h)),
        });
      }
      setActiveTool("select");
    },
    [rf, session, activeTool, editable],
  );

  useEffect(() => {
    if (!armed && activeTool !== "group") return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveTool("select");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [armed, activeTool]);

  // ---- media insert -------------------------------------------------------
  const insertMedia = useCallback(async () => {
    if (!editable || uploading) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: false,
      filters: [
        { name: "Media", extensions: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm"] },
      ],
    });
    if (!sel || Array.isArray(sel)) return;
    setUploading(true);
    try {
      // The node is added only AFTER the upload resolves — a progress overlay,
      // never a placeholder node in the shared doc.
      const up = await spacesApi.mediaUpload(convId, sel as string);
      const doc = session.doc.current;
      if (!doc) return;
      const wrap = wrapperRef.current;
      const rect = wrap?.getBoundingClientRect();
      const center = rect
        ? rf.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : { x: 0, y: 0 };
      docAddNode(doc, {
        kind: "media",
        x: center.x - 160,
        y: center.y - 110,
        width: 320,
        height: 220,
        mediaKind: up.mediaKind,
        contentHash: up.contentHash,
        mime: up.mime,
      });
    } catch (e) {
      console.error("spaces: media upload failed:", e);
    } finally {
      setUploading(false);
    }
  }, [convId, editable, rf, session, uploading]);

  // ---- undo / redo --------------------------------------------------------
  const undoMgr = session.undo.current;
  const canUndo = (undoMgr?.canUndo() ?? false) && editable;
  const canRedo = (undoMgr?.canRedo() ?? false) && editable;
  const doUndo = useCallback(() => session.undo.current?.undo(), [session]);
  const doRedo = useCallback(() => session.undo.current?.redo(), [session]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const w = wrapperRef.current;
      if (!w || w.offsetParent === null) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable))
        return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doUndo, doRedo]);

  // One glyph for the socket: live, catching up, or refused. `unavailable`
  // is the only state retrying cannot fix.
  const connection = session.meta?.connection ?? "disconnected";
  const syncState: SyncState =
    connection === "open" && ready
      ? "synced"
      : connection === "unavailable"
        ? "offline"
        : "syncing";

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    session.publishAwareness({ selection: [] });
  }, [session]);

  return (
    <SpaceCanvasContext.Provider value={ctx}>
      <div
        ref={wrapperRef}
        className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-bg-base"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {!ready && (
          <div className="absolute inset-0 z-30 flex items-center justify-center text-[11px] text-text-tertiary">
            Loading…
          </div>
        )}

        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={clearSelection}
          onMove={onMove}
          nodeTypes={SPACE_NODE_TYPES}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={40}
          minZoom={0.2}
          maxZoom={2}
          fitView
          nodesConnectable={editable}
          deleteKeyCode={editable ? ["Backspace", "Delete"] : []}
          proOptions={{ hideAttribution: true }}
          panOnScroll
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.2}
            color="rgba(255,255,255,0.18)"
          />
          <SpaceCursors actors={actors} />
        </ReactFlow>

        {(armed || activeTool === "group") && editable && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onPointerDown={overlayDown}
            onPointerMove={overlayMove}
            onPointerUp={overlayUp}
          >
            {preview && (
              <div
                className="pointer-events-none absolute rounded border border-[var(--accent-primary)] bg-[var(--accent-primary)]/10"
                style={{
                  left: preview.left,
                  top: preview.top,
                  width: preview.w,
                  height: preview.h,
                }}
              />
            )}
          </div>
        )}

        {uploading && (
          <div className="absolute bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-full border border-white/10 bg-[var(--bg-secondary)]/80 px-3 py-1 text-[11px] text-text-secondary backdrop-blur-xl">
            Uploading media…
          </div>
        )}

        <SpaceHeaderPill
          sync={syncState}
          pages={session.meta?.pages ?? []}
          activePageId={session.pageId}
          onOpenPage={session.openPage}
          pagesOpen={pagesOpen}
          onTogglePages={onTogglePages}
        />
        <SpaceActionPill convId={convId} actors={actors} onBeforeExport={clearSelection} />
        <SpaceToolbar
          activeTool={activeTool}
          onTool={setActiveTool}
          onInsertMedia={() => void insertMedia()}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={doUndo}
          onRedo={doRedo}
          disabled={!editable}
          dock={dock}
          onDock={onDock}
        />
      </div>
    </SpaceCanvasContext.Provider>
  );
}
