import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { forceLayout } from "@/lib/graph-layout";
import { loadCanvas, saveCanvas } from "../lib/canvas-api";

/** What a canvas node is. `note` = rich card (title/body/icon), `text` = chrome-
 *  less free text, `media` = image, `shape` = geometric flowchart shape with a
 *  centered text label. Defaults to `note` for legacy files. */
export type CanvasNodeKind = "note" | "text" | "media" | "shape";
export type MediaKind = "image" | "video";

/** Flowchart shape geometries. */
export type ShapeType = "rectangle" | "rounded" | "ellipse" | "diamond";

/** Active canvas tool. Create-tools drop a node on the next pane click, then
 *  revert to `select`. `connector` is a hint; connections are made by dragging
 *  between node handles (Loose mode). `shape:*` drops that geometry. */
export type CanvasTool =
  | "select"
  | "note"
  | "text"
  | "media"
  | "connector"
  | "ai"
  | `shape:${ShapeType}`;

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  // note fields
  title: string;
  body: string;
  /** Emoji shown on the note card (falls back to the sticky-note glyph). */
  icon?: string;
  // text field (also the centered label for `shape` nodes)
  text?: string;
  // shape field
  shapeType?: ShapeType;
  // media fields
  /** Relative path under `.atlas/canvas-media/` (served via canvas_media_data_url). */
  src?: string;
  mediaKind?: MediaKind;
  /** Set when this node belongs to an AI-generated group (see `CanvasAiGroup`). */
  groupId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Which side of each node the connector attaches to (t/r/b/l). */
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** Set when this edge belongs to an AI-generated group. */
  groupId?: string;
}

/** A chat message in an AI group's thread. */
export interface AiGroupMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

/** An AI-generated group of nodes/edges + the chat thread that produced/edits it.
 *  Members are tagged with `groupId`; this record holds the conversation so the
 *  user can reopen the ✨ pin and keep modifying the same diagram. */
export interface CanvasAiGroup {
  id: string;
  /** Flow-space point the group was seeded at (marker anchor fallback). */
  anchor: { x: number; y: number };
  title: string;
  messages: AiGroupMessage[];
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** One operation from the AI diagram protocol (see `lib/canvas-ai.ts`). Node
 *  coordinates are RELATIVE to the group anchor; omitted coords get auto-laid-out.
 *  `connect` endpoints are either an add_node `tempId` or an existing node id. */
export type AiOp =
  | {
      op: "add_node";
      tempId: string;
      kind: "shape" | "note" | "text";
      shapeType?: ShapeType;
      text?: string;
      title?: string;
      body?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      icon?: string;
    }
  | {
      op: "update_node";
      id: string;
      text?: string;
      title?: string;
      body?: string;
      shapeType?: ShapeType;
    }
  | { op: "delete_node"; id: string }
  | { op: "connect"; from: string; to: string }
  | { op: "delete_edge"; id: string };

/** One page's canvas data (Figma-style pages). Name/icon live in the tree entry. */
export interface CanvasPage {
  id: string;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  aiGroups: Record<string, CanvasAiGroup>;
}

/** An entry in the pages file tree — a page (has canvas data) or an organizing
 *  folder. `id` of a page entry matches its `CanvasPage.id`. */
export interface PageTreeEntry {
  id: string;
  kind: "page" | "folder";
  parentId: string | null;
  name: string;
  icon?: string;
  order: number;
}

/** Persisted file schema. v4 = multiple pages + a folder tree (Figma-style). */
interface CanvasFile {
  version: 4;
  pages: CanvasPage[];
  tree: PageTreeEntry[];
  activePageId: string;
}

interface CanvasState {
  projectPath: string | null;
  loaded: boolean;
  // The top-level nodes/edges/aiGroups/viewport are the ACTIVE page's live working
  // copy — every action + selector reads/writes these. Inactive pages live in
  // `pages`; `syncActiveIntoPages` folds the working copy back before save/switch.
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** AI-generated groups (member nodes carry `groupId`), keyed by group id. */
  aiGroups: Record<string, CanvasAiGroup>;
  viewport: CanvasViewport;
  /** All pages' persisted data, keyed by id (active page is also mirrored above). */
  pages: Record<string, CanvasPage>;
  /** The pages/folders tree (names, emojis, order, nesting). */
  tree: PageTreeEntry[];
  activePageId: string | null;
  /** Ids of currently-selected nodes (multi-select via marquee / shift-click). */
  selectedIds: string[];
  /** A group whose AI thread the canvas panel should auto-open on mount — set by
   *  external callers (e.g. "Draw diagram" from a chat turn) so the user sees the
   *  generation loading state and can keep chatting. Consumed once. */
  pendingAiThreadGroupId: string | null;
  fullscreen: boolean;
  activeTool: CanvasTool;
  /** Mirrors the module-level undo/redo stacks for toolbar button state. */
  canUndo: boolean;
  canRedo: boolean;
}

type NodePatch = Partial<
  Pick<
    CanvasNode,
    "title" | "body" | "width" | "height" | "icon" | "text" | "src" | "mediaKind" | "shapeType"
  >
>;

interface CanvasActions {
  actions: {
    loadProject: (path: string) => Promise<void>;
    addNote: (at?: { x: number; y: number }) => string;
    addText: (at?: { x: number; y: number }) => string;
    addMedia: (
      opts: { src: string; mediaKind: MediaKind; width?: number; height?: number },
      at?: { x: number; y: number },
    ) => string;
    addShape: (
      shapeType: ShapeType,
      at?: { x: number; y: number },
      size?: { width: number; height: number },
    ) => string;
    updateNote: (id: string, patch: NodePatch) => void;
    deleteNote: (id: string) => void;
    moveNote: (id: string, x: number, y: number) => void;
    addEdge: (
      source: string,
      target: string,
      sourceHandle?: string | null,
      targetHandle?: string | null,
    ) => void;
    deleteEdge: (id: string) => void;
    /** Replace the selection with a single id (or clear when null). */
    setSelected: (id: string | null) => void;
    /** Replace the whole selection set (marquee / multi-select). */
    setSelectedIds: (ids: string[]) => void;
    setViewport: (vp: CanvasViewport) => void;
    setFullscreen: (open: boolean) => void;
    toggleFullscreen: () => void;
    setTool: (tool: CanvasTool) => void;
    /** Snapshot the current nodes/edges so the next mutation is one undo step.
     *  Call at the START of a continuous interaction (node drag / resize). */
    beginInteraction: () => void;
    undo: () => void;
    redo: () => void;
    // ── Pages ──
    /** Create a new empty page (optionally inside a folder); makes it active. */
    createPage: (parentId?: string | null) => string;
    /** Create a new folder (optionally nested). */
    createPageFolder: (parentId?: string | null) => string;
    /** Switch the active page: fold the current working copy back into `pages`,
     *  then load the target page's data into the working fields. */
    setActivePage: (id: string) => void;
    renameTreeEntry: (id: string, name: string) => void;
    setTreeEntryIcon: (id: string, icon: string | null) => void;
    /** Delete a page or folder (folders cascade to descendant pages). Never
     *  removes the last remaining page. */
    deleteTreeEntry: (id: string) => void;
    // ── AI groups ──
    /** Create an empty AI group anchored at `at`; returns its id. */
    createAiGroup: (at: { x: number; y: number }, provider?: string, model?: string) => string;
    /** Append a message to a group's thread. */
    appendGroupMessage: (groupId: string, msg: AiGroupMessage) => void;
    /** Apply a batch of AI ops to a group (one undo step). New nodes are placed at
     *  `anchor` + their relative coords; missing coords get force-laid-out. */
    applyAiOps: (groupId: string, ops: AiOp[], anchor: { x: number; y: number }) => void;
    /** Delete a group: its member nodes + edges + the thread. */
    deleteGroup: (groupId: string) => void;
    /** Translate all of a group's member nodes by (dx, dy). */
    moveGroup: (groupId: string, dx: number, dy: number) => void;
    /** Select all member nodes of a group. */
    selectGroup: (groupId: string) => void;
    /** Ask the canvas panel to open a group's AI thread popover (surfaces the
     *  loading state after an externally-triggered generation). */
    requestOpenAiThread: (groupId: string) => void;
    /** Clear a pending auto-open request (called once the panel has opened it). */
    consumePendingAiThread: () => void;
  };
}

function genId(prefix: "n" | "e" | "g" | "p" | "f"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const emptyViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

function emptyPage(id: string): CanvasPage {
  return { id, viewport: { ...emptyViewport }, nodes: [], edges: [], aiGroups: {} };
}

/** Fold the active page's live working copy (top-level fields) back into `pages`
 *  so the persisted map + a page switch never lose the current edits. */
function activePageSnapshot(s: CanvasState): CanvasPage | null {
  if (!s.activePageId) return null;
  return {
    id: s.activePageId,
    viewport: s.viewport,
    nodes: s.nodes,
    edges: s.edges,
    aiGroups: s.aiGroups,
  };
}

// Debounce save per project; cleared whenever we load a different project.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 400;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const s = useCanvasStore.getState();
    if (!s.projectPath || !s.loaded || !s.activePageId) return;
    // Fold the live active page into the pages map for a complete snapshot.
    const active = activePageSnapshot(s);
    const pages = Object.values({ ...s.pages, ...(active ? { [active.id]: active } : {}) });
    const payload: CanvasFile = {
      version: 4,
      pages,
      tree: s.tree,
      activePageId: s.activePageId,
    };
    try {
      await saveCanvas(s.projectPath, JSON.stringify(payload));
    } catch (err) {
      // Silent — UI continues to function from in-memory state.
      // eslint-disable-next-line no-console
      console.error("save canvas failed", err);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ── Undo/redo snapshot stacks ────────────────────────────────────────────────
// Module-level (not reactive). The store mirrors `canUndo`/`canRedo` for the
// toolbar. A continuous drag/resize captures ONE snapshot at its start
// (`beginInteraction`), so it collapses into a single undo step — matching how
// Excalidraw batches a drag into one history entry.
interface HistorySnap {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
let past: HistorySnap[] = [];
let future: HistorySnap[] = [];
const HISTORY_CAP = 50;

function resetHistory() {
  past = [];
  future = [];
}

/** Normalize a raw nodes array (v1→v2 shape fixups). */
function normalizeNodes(raw: unknown): CanvasNode[] {
  return (Array.isArray(raw) ? raw : []).map((n) => ({
    ...(n as CanvasNode),
    kind: (n as CanvasNode).kind ?? "note",
    title: (n as CanvasNode).title ?? "",
    body: (n as CanvasNode).body ?? "",
  }));
}

/** A brand-new file with a single empty "Page 1". */
function freshFile(): CanvasFile {
  const id = genId("p");
  return {
    version: 4,
    pages: [emptyPage(id)],
    tree: [{ id, kind: "page", parentId: null, name: "Page 1", order: 0 }],
    activePageId: id,
  };
}

function parseFile(raw: string): CanvasFile {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // v4: already multi-page. Sanitize + guarantee at least one page.
    if (parsed.version === 4 && Array.isArray(parsed.pages)) {
      const pages = (parsed.pages as CanvasPage[]).map((p) => ({
        id: p.id,
        viewport: p.viewport ?? { ...emptyViewport },
        nodes: normalizeNodes(p.nodes),
        edges: Array.isArray(p.edges) ? p.edges : [],
        aiGroups: p.aiGroups && typeof p.aiGroups === "object" ? p.aiGroups : {},
      }));
      if (pages.length === 0) return freshFile();
      const tree = Array.isArray(parsed.tree) ? (parsed.tree as PageTreeEntry[]) : [];
      const activePageId =
        typeof parsed.activePageId === "string" && pages.some((p) => p.id === parsed.activePageId)
          ? (parsed.activePageId as string)
          : pages[0].id;
      return { version: 4, pages, tree, activePageId };
    }

    // v1/v2/v3 → v4: wrap the single board as "Page 1".
    const id = genId("p");
    const page: CanvasPage = {
      id,
      viewport: (parsed.viewport as CanvasViewport) ?? { ...emptyViewport },
      nodes: normalizeNodes(parsed.nodes),
      edges: Array.isArray(parsed.edges) ? (parsed.edges as CanvasEdge[]) : [],
      aiGroups:
        parsed.aiGroups && typeof parsed.aiGroups === "object"
          ? (parsed.aiGroups as Record<string, CanvasAiGroup>)
          : {},
    };
    return {
      version: 4,
      pages: [page],
      tree: [{ id, kind: "page", parentId: null, name: "Page 1", order: 0 }],
      activePageId: id,
    };
  } catch {
    return freshFile();
  }
}

export const useCanvasStore = createSelectors(
  create<CanvasState & CanvasActions>()(
    immer((set, get) => {
      // Capture the pre-mutation nodes/edges as one undo step. `get()` inside a
      // producer returns committed (pre-`set`) state, and immer never mutates a
      // previously-produced object, so storing the references is a safe snapshot.
      const takeSnapshot = () => {
        past.push({ nodes: get().nodes, edges: get().edges });
        if (past.length > HISTORY_CAP) past.shift();
        future = [];
        set((s) => {
          s.canUndo = true;
          s.canRedo = false;
        });
      };
      return {
        projectPath: null,
        loaded: false,
        nodes: [],
        edges: [],
        aiGroups: {},
        viewport: emptyViewport,
        pages: {},
        tree: [],
        activePageId: null,
        selectedIds: [],
        pendingAiThreadGroupId: null,
        fullscreen: false,
        activeTool: "select",
        canUndo: false,
        canRedo: false,
        actions: {
          loadProject: async (path) => {
            if (saveTimer) {
              clearTimeout(saveTimer);
              saveTimer = null;
            }
            set((s) => {
              s.projectPath = path;
              s.loaded = false;
              s.nodes = [];
              s.edges = [];
              s.aiGroups = {};
              s.pages = {};
              s.tree = [];
              s.activePageId = null;
              s.selectedIds = [];
              s.viewport = emptyViewport;
            });
            try {
              const raw = await loadCanvas(path);
              const parsed = parseFile(raw);
              resetHistory();
              set((s) => {
                if (s.projectPath !== path) return; // user switched projects mid-load
                const pagesMap: Record<string, CanvasPage> = {};
                for (const p of parsed.pages) pagesMap[p.id] = p;
                s.pages = pagesMap;
                s.tree = parsed.tree;
                s.activePageId = parsed.activePageId;
                // Mirror the active page into the working fields.
                const active = pagesMap[parsed.activePageId];
                s.nodes = active?.nodes ?? [];
                s.edges = active?.edges ?? [];
                s.aiGroups = active?.aiGroups ?? {};
                s.viewport = active?.viewport ?? { ...emptyViewport };
                s.loaded = true;
                s.canUndo = false;
                s.canRedo = false;
              });
            } catch {
              set((s) => {
                if (s.projectPath !== path) return;
                s.loaded = true;
              });
            }
          },
          addNote: (at) => {
            takeSnapshot();
            const id = genId("n");
            const stamp = nowIso();
            const x = at?.x ?? 0;
            const y = at?.y ?? 0;
            set((s) => {
              s.nodes.push({
                id,
                kind: "note",
                x,
                y,
                width: 320,
                title: "Untitled",
                body: "",
                createdAt: stamp,
                updatedAt: stamp,
              });
              s.selectedIds = [id];
            });
            scheduleSave();
            logEvent({ source: "canvas", kind: "note-add", summary: "New note", payload: { id } });
            return id;
          },
          addText: (at) => {
            takeSnapshot();
            const id = genId("n");
            const stamp = nowIso();
            set((s) => {
              s.nodes.push({
                id,
                kind: "text",
                x: at?.x ?? 0,
                y: at?.y ?? 0,
                width: 200,
                title: "",
                body: "",
                text: "Text",
                createdAt: stamp,
                updatedAt: stamp,
              });
              s.selectedIds = [id];
            });
            scheduleSave();
            logEvent({ source: "canvas", kind: "text-add", summary: "New text", payload: { id } });
            return id;
          },
          addShape: (shapeType, at, size) => {
            takeSnapshot();
            const id = genId("n");
            const stamp = nowIso();
            // Default sizes when placed with a click; drag-to-create passes `size`.
            const [defW, defH] =
              shapeType === "ellipse" || shapeType === "diamond" ? [130, 130] : [160, 90];
            const w = size ? Math.max(20, Math.round(size.width)) : defW;
            const h = size ? Math.max(20, Math.round(size.height)) : defH;
            set((s) => {
              s.nodes.push({
                id,
                kind: "shape",
                shapeType,
                x: at?.x ?? 0,
                y: at?.y ?? 0,
                width: w,
                height: h,
                title: "",
                body: "",
                text: "",
                createdAt: stamp,
                updatedAt: stamp,
              });
              s.selectedIds = [id];
            });
            scheduleSave();
            logEvent({ source: "canvas", kind: "shape-add", summary: shapeType, payload: { id } });
            return id;
          },
          addMedia: ({ src, mediaKind, width, height }, at) => {
            takeSnapshot();
            const id = genId("n");
            const stamp = nowIso();
            set((s) => {
              s.nodes.push({
                id,
                kind: "media",
                x: at?.x ?? 0,
                y: at?.y ?? 0,
                width: width ?? 320,
                height,
                title: "",
                body: "",
                src,
                mediaKind,
                createdAt: stamp,
                updatedAt: stamp,
              });
              s.selectedIds = [id];
            });
            scheduleSave();
            logEvent({ source: "canvas", kind: "media-add", summary: mediaKind, payload: { id } });
            return id;
          },
          updateNote: (id, patch) =>
            set((s) => {
              const n = s.nodes.find((n) => n.id === id);
              if (!n) return;
              if (patch.title !== undefined) n.title = patch.title;
              if (patch.body !== undefined) n.body = patch.body;
              if (patch.width !== undefined) n.width = patch.width;
              if (patch.height !== undefined) n.height = patch.height;
              if (patch.icon !== undefined) n.icon = patch.icon;
              if (patch.text !== undefined) n.text = patch.text;
              if (patch.src !== undefined) n.src = patch.src;
              if (patch.mediaKind !== undefined) n.mediaKind = patch.mediaKind;
              n.updatedAt = nowIso();
              scheduleSave();
            }),
          deleteNote: (id) => {
            takeSnapshot();
            const removed = get().nodes.find((n) => n.id === id);
            set((s) => {
              s.nodes = s.nodes.filter((n) => n.id !== id);
              s.edges = s.edges.filter((e) => e.source !== id && e.target !== id);
              s.selectedIds = s.selectedIds.filter((x) => x !== id);
              scheduleSave();
            });
            if (removed) {
              logEvent({
                source: "canvas",
                kind: "note-delete",
                summary: removed.title || "Untitled",
                payload: { id },
              });
            }
          },
          moveNote: (id, x, y) =>
            set((s) => {
              const n = s.nodes.find((n) => n.id === id);
              if (!n) return;
              n.x = x;
              n.y = y;
              scheduleSave();
            }),
          addEdge: (source, target, sourceHandle, targetHandle) => {
            if (source === target) return;
            const exists = get().edges.some(
              (e) =>
                (e.source === source && e.target === target) ||
                (e.source === target && e.target === source),
            );
            if (exists) return;
            takeSnapshot();
            set((s) => {
              s.edges.push({ id: genId("e"), source, target, sourceHandle, targetHandle });
              scheduleSave();
            });
            logEvent({
              source: "canvas",
              kind: "edge-add",
              summary: "Connection added",
              payload: { source, target },
            });
          },
          deleteEdge: (id) => {
            takeSnapshot();
            set((s) => {
              s.edges = s.edges.filter((e) => e.id !== id);
              scheduleSave();
            });
            logEvent({
              source: "canvas",
              kind: "edge-delete",
              summary: "Connection removed",
              payload: { id },
            });
          },
          setSelected: (id) =>
            set((s) => {
              s.selectedIds = id ? [id] : [];
            }),
          setSelectedIds: (ids) =>
            set((s) => {
              s.selectedIds = ids;
            }),
          setViewport: (vp) =>
            set((s) => {
              s.viewport = vp;
              scheduleSave();
            }),
          setFullscreen: (open) =>
            set((s) => {
              s.fullscreen = open;
            }),
          toggleFullscreen: () =>
            set((s) => {
              s.fullscreen = !s.fullscreen;
            }),
          setTool: (tool) =>
            set((s) => {
              s.activeTool = tool;
            }),
          beginInteraction: () => takeSnapshot(),
          undo: () => {
            if (past.length === 0) return;
            future.push({ nodes: get().nodes, edges: get().edges });
            const prev = past.pop()!;
            set((s) => {
              s.nodes = prev.nodes;
              s.edges = prev.edges;
              s.canUndo = past.length > 0;
              s.canRedo = true;
            });
            scheduleSave();
          },
          redo: () => {
            if (future.length === 0) return;
            past.push({ nodes: get().nodes, edges: get().edges });
            const next = future.pop()!;
            set((s) => {
              s.nodes = next.nodes;
              s.edges = next.edges;
              s.canUndo = true;
              s.canRedo = future.length > 0;
            });
            scheduleSave();
          },

          // ── Pages ──────────────────────────────────────────────────────────
          createPage: (parentId = null) => {
            const id = genId("p");
            set((s) => {
              s.pages[id] = emptyPage(id);
              const order = s.tree.filter((e) => e.parentId === parentId).length;
              s.tree.push({ id, kind: "page", parentId, name: "Untitled", order });
              // Fold the outgoing page back, then switch to the new (empty) page.
              const active = activePageSnapshot(s);
              if (active) s.pages[active.id] = active;
              s.activePageId = id;
              s.nodes = [];
              s.edges = [];
              s.aiGroups = {};
              s.viewport = { ...emptyViewport };
              s.selectedIds = [];
            });
            resetHistory();
            set((s) => {
              s.canUndo = false;
              s.canRedo = false;
            });
            scheduleSave();
            logEvent({ source: "canvas", kind: "page-add", summary: "New page", payload: { id } });
            return id;
          },

          createPageFolder: (parentId = null) => {
            const id = genId("f");
            set((s) => {
              const order = s.tree.filter((e) => e.parentId === parentId).length;
              s.tree.push({ id, kind: "folder", parentId, name: "New folder", order });
            });
            scheduleSave();
            return id;
          },

          setActivePage: (id) => {
            if (get().activePageId === id) return;
            set((s) => {
              const target = s.pages[id];
              if (!target) return;
              // Fold the current working copy back into pages, then load the target.
              const active = activePageSnapshot(s);
              if (active) s.pages[active.id] = active;
              s.activePageId = id;
              s.nodes = target.nodes;
              s.edges = target.edges;
              s.aiGroups = target.aiGroups;
              s.viewport = target.viewport;
              s.selectedIds = [];
            });
            resetHistory();
            set((s) => {
              s.canUndo = false;
              s.canRedo = false;
            });
            scheduleSave();
          },

          renameTreeEntry: (id, name) =>
            set((s) => {
              const e = s.tree.find((t) => t.id === id);
              if (!e) return;
              e.name = name;
              scheduleSave();
            }),

          setTreeEntryIcon: (id, icon) =>
            set((s) => {
              const e = s.tree.find((t) => t.id === id);
              if (!e) return;
              e.icon = icon ?? undefined;
              scheduleSave();
            }),

          deleteTreeEntry: (id) => {
            set((s) => {
              // Collect the entry + all descendants (folders cascade).
              const toRemove = new Set<string>([id]);
              let grew = true;
              while (grew) {
                grew = false;
                for (const e of s.tree) {
                  if (e.parentId && toRemove.has(e.parentId) && !toRemove.has(e.id)) {
                    toRemove.add(e.id);
                    grew = true;
                  }
                }
              }
              const removedPageIds = s.tree
                .filter((e) => toRemove.has(e.id) && e.kind === "page")
                .map((e) => e.id);
              const remainingPages = s.tree.filter((e) => e.kind === "page" && !toRemove.has(e.id));
              // Never delete the last page.
              if (remainingPages.length === 0) return;

              s.tree = s.tree.filter((e) => !toRemove.has(e.id));
              for (const pid of removedPageIds) delete s.pages[pid];

              // If the active page was removed, switch to another page.
              if (s.activePageId && removedPageIds.includes(s.activePageId)) {
                const next = remainingPages[0];
                const target = s.pages[next.id];
                s.activePageId = next.id;
                s.nodes = target?.nodes ?? [];
                s.edges = target?.edges ?? [];
                s.aiGroups = target?.aiGroups ?? {};
                s.viewport = target?.viewport ?? { ...emptyViewport };
                s.selectedIds = [];
              }
              scheduleSave();
            });
          },

          // ── AI groups ──────────────────────────────────────────────────────
          createAiGroup: (at, provider, model) => {
            const id = genId("g");
            const stamp = nowIso();
            set((s) => {
              s.aiGroups[id] = {
                id,
                anchor: { x: at.x, y: at.y },
                title: "AI diagram",
                messages: [],
                provider,
                model,
                createdAt: stamp,
                updatedAt: stamp,
              };
            });
            scheduleSave();
            return id;
          },

          appendGroupMessage: (groupId, msg) =>
            set((s) => {
              const g = s.aiGroups[groupId];
              if (!g) return;
              g.messages.push(msg);
              g.updatedAt = nowIso();
              scheduleSave();
            }),

          applyAiOps: (groupId, ops, anchor) => {
            takeSnapshot(); // whole batch = one undo step
            const stamp = nowIso();
            set((s) => {
              const temp = new Map<string, string>(); // tempId → real node id
              const addedIds: string[] = [];
              let allHaveCoords = true;

              for (const op of ops) {
                if (op.op !== "add_node") continue;
                const id = genId("n");
                temp.set(op.tempId, id);
                addedIds.push(id);
                if (op.x === undefined || op.y === undefined) allHaveCoords = false;
                const [dw, dh] =
                  op.kind === "shape" && (op.shapeType === "ellipse" || op.shapeType === "diamond")
                    ? [130, 130]
                    : op.kind === "shape"
                      ? [160, 90]
                      : op.kind === "note"
                        ? [320, undefined as number | undefined]
                        : [200, undefined as number | undefined];
                s.nodes.push({
                  id,
                  kind: op.kind,
                  groupId,
                  x: anchor.x + (op.x ?? 0),
                  y: anchor.y + (op.y ?? 0),
                  width: op.width ?? dw,
                  height: op.height ?? dh,
                  title: op.title ?? (op.kind === "note" ? "Untitled" : ""),
                  body: op.body ?? "",
                  text:
                    op.text ??
                    (op.kind === "text" ? "Text" : op.kind === "shape" ? (op.title ?? "") : ""),
                  shapeType: op.kind === "shape" ? (op.shapeType ?? "rectangle") : undefined,
                  icon: op.icon,
                  createdAt: stamp,
                  updatedAt: stamp,
                });
              }

              const resolve = (ref: string) => temp.get(ref) ?? ref;
              const nodeExists = (nid: string) => s.nodes.some((n) => n.id === nid);

              for (const op of ops) {
                if (op.op === "connect") {
                  const from = resolve(op.from);
                  const to = resolve(op.to);
                  if (from === to || !nodeExists(from) || !nodeExists(to)) continue;
                  const dup = s.edges.some(
                    (e) =>
                      (e.source === from && e.target === to) ||
                      (e.source === to && e.target === from),
                  );
                  if (dup) continue;
                  s.edges.push({ id: genId("e"), source: from, target: to, groupId });
                } else if (op.op === "update_node") {
                  const n = s.nodes.find((x) => x.id === op.id);
                  if (!n) continue;
                  if (op.text !== undefined) n.text = op.text;
                  if (op.title !== undefined) n.title = op.title;
                  if (op.body !== undefined) n.body = op.body;
                  if (op.shapeType !== undefined) n.shapeType = op.shapeType;
                  n.updatedAt = stamp;
                } else if (op.op === "delete_node") {
                  s.nodes = s.nodes.filter((n) => n.id !== op.id);
                  s.edges = s.edges.filter((e) => e.source !== op.id && e.target !== op.id);
                } else if (op.op === "delete_edge") {
                  s.edges = s.edges.filter((e) => e.id !== op.id);
                }
              }

              // If the model didn't give coordinates for every new node, force-lay
              // them out (over the group's own edges) in a box seeded at the anchor.
              if (addedIds.length > 1 && !allHaveCoords) {
                const deg = new Map<string, number>();
                for (const e of s.edges) {
                  if (e.groupId !== groupId) continue;
                  deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
                  deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
                }
                const layoutNodes = addedIds.map((nid) => ({ id: nid, degree: deg.get(nid) ?? 0 }));
                const layoutEdges = s.edges
                  .filter((e) => e.groupId === groupId)
                  .map((e) => ({ from: e.source, to: e.target }));
                const pos = forceLayout(layoutNodes, layoutEdges, 720, 480, { spacing: 1.1 });
                for (const nid of addedIds) {
                  const p = pos[nid];
                  const n = s.nodes.find((x) => x.id === nid);
                  if (p && n) {
                    n.x = anchor.x + p.x;
                    n.y = anchor.y + p.y;
                  }
                }
              }

              const g = s.aiGroups[groupId];
              if (g) g.updatedAt = stamp;
              scheduleSave();
            });
          },

          deleteGroup: (groupId) => {
            takeSnapshot();
            set((s) => {
              s.nodes = s.nodes.filter((n) => n.groupId !== groupId);
              s.edges = s.edges.filter((e) => e.groupId !== groupId);
              delete s.aiGroups[groupId];
              s.selectedIds = [];
              scheduleSave();
            });
          },

          moveGroup: (groupId, dx, dy) =>
            set((s) => {
              for (const n of s.nodes) {
                if (n.groupId === groupId) {
                  n.x += dx;
                  n.y += dy;
                }
              }
              const g = s.aiGroups[groupId];
              if (g) {
                g.anchor.x += dx;
                g.anchor.y += dy;
              }
              scheduleSave();
            }),

          selectGroup: (groupId) =>
            set((s) => {
              s.selectedIds = s.nodes.filter((n) => n.groupId === groupId).map((n) => n.id);
            }),

          requestOpenAiThread: (groupId) =>
            set((s) => {
              s.pendingAiThreadGroupId = groupId;
            }),

          consumePendingAiThread: () =>
            set((s) => {
              s.pendingAiThreadGroupId = null;
            }),
        },
      };
    }),
  ),
);

/** Bounding box (flow space) of a group's member nodes, or null if none. Used to
 *  place the ✨ marker pin and frame. */
export function groupBounds(
  nodes: CanvasNode[],
  groupId: string,
): { x: number; y: number; width: number; height: number } | null {
  const members = nodes.filter((n) => n.groupId === groupId);
  if (members.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of members) {
    const w = n.width ?? 160;
    const h = n.height ?? 90;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
