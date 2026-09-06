import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  ConnectionMode,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as Dialog from "@radix-ui/react-dialog";
import { StickyNote } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useCanvasStore, type CanvasNode, type ShapeType } from "../stores/canvas-store";
import { canvasMediaUpload } from "../lib/canvas-api";
import { NoteNode } from "./note-node";
import { TextNode } from "./text-node";
import { MediaNode } from "./media-node";
import { ShapeNode } from "./shape-node";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasHeader } from "./canvas-header";
import { CanvasExportToolbar } from "./canvas-export-toolbar";
import { PagesPanel } from "./pages-panel";
import { NoteEditorPanel } from "./note-editor-panel";

const nodeTypes = {
  note: NoteNode,
  text: TextNode,
  media: MediaNode,
  shape: ShapeNode,
};

export function CanvasPanel() {
  const fullscreen = useCanvasStore.use.fullscreen();
  const { setFullscreen } = useCanvasStore.use.actions();

  // The same canvas surface is rendered inside a Dialog when fullscreen is on,
  // otherwise inline. We toss away the inline tree while fullscreen so we
  // never have two ReactFlow instances competing for state at once.
  const surface = (
    <ReactFlowProvider>
      <CanvasSurface
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen(!fullscreen)}
      />
    </ReactFlowProvider>
  );

  if (!fullscreen) return surface;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && setFullscreen(false)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 bg-black/60"
          style={{ zIndex: "var(--z-overlay)" as unknown as number }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-12 left-6 right-6 bottom-6 rounded-xl border border-[var(--border-default)] bg-[var(--bg-base)] overflow-hidden flex flex-col shadow-[var(--shadow-overlay)] focus:outline-none"
          style={{ zIndex: "var(--z-modal)" as unknown as number }}
        >
          <Dialog.Title className="sr-only">Spaces</Dialog.Title>
          {surface}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CanvasSurface({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const project = useProjectStore.use.currentProject();
  const projectPath = project?.path ?? null;

  const storeProjectPath = useCanvasStore.use.projectPath();
  const nodes = useCanvasStore.use.nodes();
  const edges = useCanvasStore.use.edges();
  const tree = useCanvasStore.use.tree();
  const activePageId = useCanvasStore.use.activePageId();
  const selectedIds = useCanvasStore.use.selectedIds();
  const loaded = useCanvasStore.use.loaded();
  const activeTool = useCanvasStore.use.activeTool();
  const canUndo = useCanvasStore.use.canUndo();
  const canRedo = useCanvasStore.use.canRedo();
  const {
    loadProject,
    addNote,
    addText,
    addMedia,
    addShape,
    moveNote,
    deleteNote,
    addEdge,
    deleteEdge,
    setSelected,
    setSelectedIds,
    setViewport,
    setTool,
    beginInteraction,
    undo,
    redo,
  } = useCanvasStore.use.actions();

  // A create-tool is armed → the click overlay is active.
  const armed = activeTool === "note" || activeTool === "text" || activeTool.startsWith("shape:");

  // Which note is open in the slide-in editor (null = closed). Notes open on
  // double-click; text edits inline; media has no editor.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("atlas:canvas:pagesOpen") === "1";
    } catch {
      return false;
    }
  });
  const togglePages = () =>
    setPagesOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem("atlas:canvas:pagesOpen", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  const activeEntry = tree.find((e) => e.id === activePageId);
  const pageName = activeEntry?.name ?? "Spaces";
  const pageIcon = activeEntry?.icon ?? null;

  // Load when the project changes.
  useEffect(() => {
    if (!projectPath) return;
    if (storeProjectPath !== projectPath) {
      loadProject(projectPath).catch(() => {});
    }
  }, [projectPath, storeProjectPath, loadProject]);

  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Project store data → xyflow shape. Node `type` = kind so xyflow routes to the
  // right renderer; `data` carries only what that renderer needs.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        selected: selectedSet.has(n.id),
        // Shapes are resizable, so React Flow owns their box dimensions.
        ...(n.kind === "shape" ? { width: n.width ?? 160, height: n.height ?? 90 } : {}),
        data:
          n.kind === "note"
            ? { title: n.title, body: n.body, updatedAt: n.updatedAt, icon: n.icon }
            : n.kind === "text"
              ? { text: n.text ?? "" }
              : n.kind === "shape"
                ? { shapeType: n.shapeType ?? "rectangle", text: n.text ?? "" }
                : {
                    src: n.src ?? "",
                    projectPath: projectPath ?? "",
                    width: n.width,
                  },
        draggable: true,
      })),
    [nodes, selectedSet, projectPath],
  );
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        type: "smoothstep",
        style: { stroke: "rgba(255,255,255,0.25)", strokeWidth: 1.5 },
      })),
    [edges],
  );

  const allNodes = rfNodes;

  // Apply position/remove/selection changes back to the store. Selection is
  // multi (marquee): fold every select change into the current set.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let selChanged = false;
      const sel = new Set(useCanvasStore.getState().selectedIds);
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          moveNote(c.id, c.position.x, c.position.y);
        } else if (c.type === "remove") {
          deleteNote(c.id);
        } else if (c.type === "select") {
          selChanged = true;
          if (c.selected) sel.add(c.id);
          else sel.delete(c.id);
        }
      }
      if (selChanged) setSelectedIds([...sel]);
    },
    [moveNote, deleteNote, setSelectedIds],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === "remove") deleteEdge(c.id);
      }
    },
    [deleteEdge],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) addEdge(c.source, c.target, c.sourceHandle, c.targetHandle);
    },
    [addEdge],
  );

  const viewportCenter = useCallback(
    (dx = 0, dy = 0) => {
      const wrap = wrapperRef.current;
      if (!wrap) return undefined;
      const rect = wrap.getBoundingClientRect();
      const c = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      return { x: c.x + dx, y: c.y + dy };
    },
    [rf],
  );

  // Empty-canvas click just clears selection. Create-tools are handled by the
  // drag-to-create overlay (which covers the pane while a create-tool is armed).
  const onPaneClick = useCallback(() => setSelected(null), [setSelected]);

  // ── Drag-to-create (Excalidraw-style) ──────────────────────────────────────
  // While a create-tool is armed, an overlay captures pointer drags: press+drag
  // sizes the shape (Shift = 1:1 square), a plain click drops a default size.
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
      if (!st) return;
      const tool = useCanvasStore.getState().activeTool;
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
      const tiny = w < 8 && h < 8; // treat as a click → default size
      if (tool.startsWith("shape:")) {
        const type = tool.slice(6) as ShapeType;
        if (tiny) addShape(type, { x: st.fx - 65, y: st.fy - 45 });
        else addShape(type, { x, y }, { width: w, height: h });
      } else if (tool === "note") {
        addNote({ x: st.fx - 130, y: st.fy - 40 });
      } else if (tool === "text") {
        addText({ x: st.fx, y: st.fy });
      }
      setTool("select");
    },
    [rf, addShape, addNote, addText, setTool],
  );

  // Escape disarms a create-tool (back to the default pointer/pan mode).
  useEffect(() => {
    if (!armed) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTool("select");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [armed, setTool]);

  // Undo / redo — Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y. Only when the
  // canvas tab is actually visible and focus isn't in a text field/editor.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const w = wrapperRef.current;
      if (!w || w.offsetParent === null) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable))
        return;
      if (matchesAction(e, "canvas.undo")) {
        e.preventDefault();
        undo();
      } else if (matchesAction(e, "canvas.redo")) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  const handleInsertMedia = useCallback(async () => {
    if (!projectPath) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: false,
      filters: [
        { name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"] },
      ],
    });
    if (!sel || Array.isArray(sel)) return;
    const path = sel as string;
    try {
      const rel = await canvasMediaUpload(projectPath, path);
      addMedia({ src: rel, mediaKind: "image" }, viewportCenter(-160, -90));
    } catch {
      /* silent — the dialog can be retried */
    }
  }, [projectPath, addMedia, viewportCenter]);

  const handleFit = useCallback(() => {
    if (nodes.length === 0) return;
    rf.fitView({ duration: 350, padding: 0.2 });
  }, [rf, nodes.length]);

  const onMoveEnd = useCallback(
    (_: unknown, vp: { x: number; y: number; zoom: number }) => {
      setViewport(vp);
    },
    [setViewport],
  );

  const jumpToNode = useCallback(
    (id: string) => {
      const n = (useCanvasStore.getState().nodes as CanvasNode[]).find((nn) => nn.id === id);
      if (!n) return;
      rf.setCenter(n.x + 160, n.y + 60, { duration: 350, zoom: rf.getZoom() });
    },
    [rf],
  );

  // Open the slide-in editor on a note double-click (text/media aren't notes).
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const n = useCanvasStore.getState().nodes.find((x) => x.id === node.id);
    if (n?.kind === "note") setEditingId(node.id);
  }, []);

  if (!projectPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-[12px] text-text-tertiary gap-2 px-6 text-center">
        <StickyNote size={18} className="opacity-60" />
        <div>No project open.</div>
        <div className="text-[10px]">Spaces are per-project. Open a folder to start a board.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {pagesOpen && <PagesPanel />}
      <div ref={wrapperRef} className="relative min-h-0 min-w-0 flex-1 bg-bg-base overflow-hidden">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-tertiary z-30">
            Loading…
          </div>
        )}

        <ReactFlow
          nodes={allNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={() => beginInteraction()}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={onPaneClick}
          onMoveEnd={onMoveEnd}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={40}
          minZoom={0.2}
          maxZoom={2}
          fitView={false}
          defaultViewport={useCanvasStore.getState().viewport}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
          // Drag empty canvas to pan (hold Space also pans); click selects a node;
          // Shift-click multi-selects. No marquee tool (it fought Space-to-pan).
          panOnScroll
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.2}
            color="rgba(255,255,255,0.18)"
          />
        </ReactFlow>

        {/* Drag-to-create overlay — only mounted while a create-tool is armed. */}
        {armed && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onPointerDown={overlayDown}
            onPointerMove={overlayMove}
            onPointerUp={overlayUp}
          >
            {preview && (
              <div
                className="absolute rounded border border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 pointer-events-none"
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

        {/* Floating overlays (Miro-style) */}
        <CanvasHeader
          pageName={pageName}
          pageIcon={pageIcon}
          pagesOpen={pagesOpen}
          onTogglePages={togglePages}
          fullscreen={fullscreen}
          onFit={handleFit}
          onToggleFullscreen={onToggleFullscreen}
        />
        <CanvasExportToolbar />
        <CanvasToolbar
          activeTool={activeTool}
          onTool={setTool}
          onInsertMedia={handleInsertMedia}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
        />

        {editingId && (
          <NoteEditorPanel
            key={editingId}
            noteId={editingId}
            projectPath={projectPath}
            onClose={() => setEditingId(null)}
            onJumpToNode={(id) => {
              setEditingId(id);
              jumpToNode(id);
            }}
          />
        )}
      </div>
    </div>
  );
}

// Keep the named export the rest of the app already imports.
export { CanvasPanel as default };
