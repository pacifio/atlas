import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  type Ticker,
  type FederatedPointerEvent,
} from "pixi.js";
import Matter from "matter-js";
import { invoke } from "@tauri-apps/api/core";
import { forceLayout } from "@/lib/graph-layout";
import { GraphRuler, type Viewport } from "@/components/graph-ruler";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useKnowledgeMetaStore } from "../stores/knowledge-meta-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useKnowledgeGraphStore,
  useProjectGraph,
  type ProjectGraph,
} from "../stores/knowledge-graph-store";

/**
 * Obsidian-style force-directed knowledge graph.
 *
 * Pixi is driven imperatively (not via @pixi/react) because @pixi/react@8
 * augments React's JSX namespace globally and breaks unrelated component
 * typing in Atlas.
 */

const RESOLUTION = 2;
const NODE_CAP = 1000;

const COLOR_PRIMARY = 0xfafafa;
const COLOR_SECONDARY = 0xc4c4c4;
const COLOR_MUTED = 0x5e5e5e;
const COLOR_EDGE_DEFAULT = 0x333333;
const COLOR_EDGE_SELECTED = 0xc4c4c4;
const COLOR_EDGE_DIM = 0x262626;

const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.004;
const HIDE_LABEL_BELOW = 0.5;
const DOUBLE_CLICK_MS = 280;
/** Constant screen-px gap between a node's disc and its label (counter-scaled). */
const LABEL_GAP = 6;

function nodeRadiusForDegree(degree: number): number {
  return Math.min(3 + Math.sqrt(Math.max(0, degree)) * 1.6, 14);
}

interface NodeView {
  id: string;
  body: Matter.Body;
  radius: number;
  graphics: Graphics;
  label: Text;
}

interface EdgeView {
  from: string;
  to: string;
  graphics: Graphics;
}

interface SceneState {
  selectedId: string | null;
  neighbors: Set<string>;
  /** Body the user is currently dragging — treated as a transient
   *  highlight so edges + neighbours light up live, not on release. */
  draggingId: string | null;
  draggingNeighbors: Set<string>;
  zoom: number;
}

/** Per-node {x, y} world-space positions. Loaded from disk on mount,
 *  saved on unmount + on a debounced timer while the simulation runs.
 *  Mirrors the Rust `GraphLayout` shape in `knowledge_graph_layout.rs`. */
interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
}

export function KnowledgeGraph() {
  const currentProject = useProjectStore.use.currentProject();
  const { bind, unbind } = useKnowledgeGraphStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const { selectEntry } = useKnowledgeStore.use.actions();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { graph: rawGraph, loading } = useProjectGraph();
  const metaPages = useKnowledgeMetaStore.use.pages();
  // Persisted positions — loaded once per project, then passed into
  // GraphCanvas as the initial body layout. `undefined` while in
  // flight; `{}` (empty positions) when none on disk.
  const [layout, setLayout] = useState<GraphLayout | undefined>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    void invoke<GraphLayout>("knowledge_graph_layout_load", {
      projectPath: currentProject.path,
    })
      .then((l) => {
        if (!cancelled) setLayout(l ?? { positions: {} });
      })
      .catch(() => {
        if (!cancelled) setLayout({ positions: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject?.path]);

  // Override node titles with `meta.title` when set — the wire-side
  // title from Rust is the filename, so this is the user-edited
  // page-header label.
  const graph = useMemo<ProjectGraph>(() => {
    if (!rawGraph.nodes.length) return rawGraph;
    return {
      ...rawGraph,
      nodes: rawGraph.nodes.map((n) => {
        const override = metaPages[n.id]?.title?.trim();
        return override ? { ...n, title: override } : n;
      }),
    };
  }, [rawGraph, metaPages]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Skip 0×0 reports — they happen every time this tab is hidden
      // (`display: none` in the persistent-tab container collapses
      // layout). Acting on them would rebuild the entire Pixi scene
      // and wipe node positions on every tab switch.
      if (width === 0 || height === 0) return;
      setSize({
        width: Math.max(200, Math.floor(width)),
        height: Math.max(200, Math.floor(height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (currentProject) void bind(currentProject.path);
    return () => unbind();
  }, [currentProject?.path, bind, unbind]);

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Open a project first
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative"
      style={{ background: "var(--bg-canvas)" }}
    >
      {loading ? (
        <LoadingState />
      ) : graph.nodes.length === 0 ? (
        <EmptyState />
      ) : graph.nodes.length > NODE_CAP ? (
        <div className="h-full w-full flex items-center justify-center text-text-tertiary text-sm">
          Graph too large — {graph.nodes.length} nodes (cap {NODE_CAP}).
        </div>
      ) : size.width > 0 && size.height > 0 && layout !== undefined ? (
        <GraphCanvas
          graph={graph}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          onSelect={setSelectedId}
          initialLayout={layout}
          projectPath={currentProject.path}
          onActivate={(entryId) => {
            addTab({
              id: "knowledge",
              type: "knowledge",
              title: "Knowledge",
              closable: true,
              dirty: false,
              data: {},
            });
            selectEntry(entryId);
          }}
        />
      ) : null}
    </div>
  );
}

function GraphCanvas({
  graph,
  width,
  height,
  selectedId,
  onSelect,
  onActivate,
  initialLayout,
  projectPath,
}: {
  graph: ProjectGraph;
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  initialLayout: GraphLayout;
  projectPath: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRafRef = useRef(false);
  // Selection state is pushed in via a ref so it doesn't force a Pixi
  // teardown/recreate cycle.
  const sceneRef = useRef<SceneState>({
    selectedId,
    neighbors: new Set(),
    draggingId: null,
    draggingNeighbors: new Set(),
    zoom: 1,
  });

  useEffect(() => {
    const neighbors = new Set<string>();
    if (selectedId) {
      for (const e of graph.edges) {
        if (e.from === selectedId) neighbors.add(e.to);
        else if (e.to === selectedId) neighbors.add(e.from);
      }
    }
    sceneRef.current = { ...sceneRef.current, selectedId, neighbors };
  }, [selectedId, graph.edges]);

  // Esc deselects (mirrors the "click empty area" affordance).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedId !== null) onSelect(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;
    let createdApp: Application | null = null;

    // Canvas built imperatively each mount so React StrictMode's
    // double-mount can't hand a half-destroyed WebGL canvas to a fresh
    // Pixi Application (caused the `shaderSource` crash in WKWebView).
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const app = new Application();
    createdApp = app;
    void app
      .init({
        canvas,
        width,
        height,
        resolution: RESOLUTION,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
        // WKWebView's WebGL2 path is flaky; pin v1.
        preferWebGLVersion: 1,
      })
      .then(() => {
        if (disposed) {
          try {
            app.destroy(true, { children: true });
          } catch {
            /* ignore */
          }
          return;
        }
        const pushViewport = (v: Viewport) => {
          vpRef.current = v;
          if (!vpRafRef.current) {
            vpRafRef.current = true;
            requestAnimationFrame(() => {
              vpRafRef.current = false;
              setViewport(vpRef.current);
            });
          }
        };
        teardown = buildScene(
          app,
          graph,
          width,
          height,
          sceneRef,
          onSelect,
          onActivate,
          initialLayout,
          projectPath,
          pushViewport,
        );
      })
      .catch(() => {
        // Disposal cleanup below handles the fallout.
      });

    return () => {
      disposed = true;
      if (teardown) {
        try {
          teardown();
        } catch {
          /* ignore */
        }
      }
      if (createdApp) {
        try {
          createdApp.destroy(true, { children: true });
        } catch {
          /* ignore */
        }
      }
      try {
        host.removeChild(canvas);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
      <GraphRuler width={width} height={height} viewport={viewport} />
    </div>
  );
}

/**
 * Builds the scene graph + Matter world + per-tick draw loop.
 * Returns a teardown function the caller invokes on unmount.
 */
function buildScene(
  app: Application,
  graph: ProjectGraph,
  width: number,
  height: number,
  sceneRef: React.MutableRefObject<SceneState>,
  onSelect: (id: string | null) => void,
  onActivate: (id: string) => void,
  initialLayout: GraphLayout,
  projectPath: string,
  onViewport: (v: Viewport) => void,
): () => void {
  // ── Physics ──────────────────────────────────────────────────
  const engine = Matter.Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;
  engine.constraintIterations = 7;

  const walls = [
    Matter.Bodies.rectangle(width / 2, height + 50, width + 200, 100, {
      isStatic: true,
    }),
    Matter.Bodies.rectangle(width / 2, -50, width + 200, 100, {
      isStatic: true,
    }),
    Matter.Bodies.rectangle(-50, height / 2, 100, height + 200, {
      isStatic: true,
    }),
    Matter.Bodies.rectangle(width + 50, height / 2, 100, height + 200, {
      isStatic: true,
    }),
  ];
  Matter.Composite.add(engine.world, walls);

  // ── Scene graph ──────────────────────────────────────────────
  const viewport = new Container();
  app.stage.addChild(viewport);
  // Background hit area: click empty → clear selection.
  const bgHit = new Graphics();
  bgHit.rect(-1e5, -1e5, 2e5, 2e5).fill({ color: 0x000000, alpha: 0 });
  bgHit.eventMode = "static";
  bgHit.on("pointertap", () => onSelect(null));
  viewport.addChild(bgHit);

  const edgeLayer = new Container();
  const nodeLayer = new Container();
  const labelLayer = new Container();
  viewport.addChild(edgeLayer, nodeLayer, labelLayer);

  // ── Initial circular layout ──────────────────────────────────
  const nodesById = new Map<string, NodeView>();
  const cx = width / 2;
  const cy = height / 2;

  // Obsidian-style spider seed: force-directed initial positions so hubs sit
  // central and leaves fan out, instead of a flat ring. Saved layouts win.
  const seedMap = forceLayout(
    graph.nodes.map((nd) => ({
      id: nd.id,
      degree: nd.inDegree + nd.outDegree,
    })),
    graph.edges,
    width,
    height,
  );

  const labelStyles = new Map<string, TextStyle>();
  const styleFor = (fill: string): TextStyle => {
    let s = labelStyles.get(fill);
    if (!s) {
      s = new TextStyle({
        fontFamily: "Inter, -apple-system, system-ui, sans-serif",
        fontSize: 11,
        fontWeight: "500",
        fill,
        align: "center",
      });
      labelStyles.set(fill, s);
    }
    return s;
  };

  graph.nodes.forEach((node) => {
    // Use the persisted position when one's on file; otherwise fall back
    // to the force-directed spider seed so the graph opens hub-and-spoke.
    const saved = initialLayout.positions[node.id];
    const seed = seedMap[node.id];
    const x = saved ? saved.x : seed ? seed.x : cx;
    const y = saved ? saved.y : seed ? seed.y : cy;
    const radius = nodeRadiusForDegree(node.inDegree + node.outDegree);
    const body = Matter.Bodies.circle(x, y, radius, {
      friction: 1,
      density: 0.1,
      restitution: 0,
      frictionAir: 0.09,
      frictionStatic: 1,
    });
    Matter.Composite.add(engine.world, body);

    const graphics = new Graphics();
    graphics.eventMode = "static";
    graphics.cursor = "pointer";
    let lastTapAt = 0;
    graphics.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      const now = performance.now();
      if (now - lastTapAt < DOUBLE_CLICK_MS) {
        onActivate(node.id);
        lastTapAt = 0;
      } else {
        onSelect(node.id);
        lastTapAt = now;
      }
    });
    nodeLayer.addChild(graphics);

    const label = new Text({ text: node.title, style: styleFor("#c4c4c4") });
    label.anchor.set(0.5, 0); // top-center: hangs below the disc
    labelLayer.addChild(label);

    nodesById.set(node.id, { id: node.id, body, radius, graphics, label });
  });

  const edges: EdgeView[] = graph.edges.map((e) => {
    const g = new Graphics();
    edgeLayer.addChild(g);
    return { from: e.from, to: e.to, graphics: g };
  });

  // ── Matter mouse + drag-highlight ────────────────────────────
  const mouse = Matter.Mouse.create(app.canvas as HTMLCanvasElement);
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: {
      stiffness: 0.2,
      render: { visible: false } as Matter.IConstraintRenderDefinition,
    },
  });
  Matter.Composite.add(engine.world, mouseConstraint);

  // Matter computes:
  //   position = absolute * (width/clientWidth) * scale + offset
  // With Pixi resolution=2, (width/clientWidth)=2 → we need scale 0.5
  // to land in CSS pixels (where the bodies live). To also factor in
  // the Pixi viewport pan/zoom we want
  //   world = (canvas - viewportPos) / viewportScale
  // → scale = 1 / (RESOLUTION * z),  offset = -viewportPos / z.
  // Call this after every viewport change so picking stays aligned.
  const syncMouseToViewport = () => {
    const z = viewport.scale.x;
    const s = 1 / (RESOLUTION * z);
    Matter.Mouse.setScale(mouse, { x: s, y: s });
    Matter.Mouse.setOffset(mouse, {
      x: -viewport.position.x / z,
      y: -viewport.position.y / z,
    });
    onViewport({ x: viewport.position.x, y: viewport.position.y, scale: z });
  };
  syncMouseToViewport();

  // While the user is dragging a node, light up its neighbours live.
  Matter.Events.on(
    mouseConstraint,
    "startdrag",
    (ev: Matter.IEvent<Matter.MouseConstraint>) => {
      const dragged = (ev as unknown as { body?: Matter.Body }).body;
      if (!dragged) return;
      for (const node of nodesById.values()) {
        if (node.body !== dragged) continue;
        const ns = new Set<string>();
        for (const e of graph.edges) {
          if (e.from === node.id) ns.add(e.to);
          else if (e.to === node.id) ns.add(e.from);
        }
        sceneRef.current = {
          ...sceneRef.current,
          draggingId: node.id,
          draggingNeighbors: ns,
        };
        break;
      }
    },
  );
  Matter.Events.on(mouseConstraint, "enddrag", () => {
    sceneRef.current = {
      ...sceneRef.current,
      draggingId: null,
      draggingNeighbors: new Set(),
    };
  });

  // ── Viewport pan / zoom ──────────────────────────────────────
  // Two pan paths:
  //   • Middle / right-click drag — goes through pointer events.
  //   • Space + left-click drag   — flips into a hard "pan mode" that
  //     removes Matter's MouseConstraint and disables Pixi interaction
  //     for the duration, then restores both on release.
  let panStart: {
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null = null;
  let panMode = false;
  let panOrigin: {
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null = null;
  let spaceHeld = false;
  const stageEventMode = app.stage.eventMode;
  const canvas = app.canvas as HTMLCanvasElement;

  const setCursor = () => {
    const grabbing = panStart !== null || panMode;
    canvas.style.cursor = grabbing
      ? "grabbing"
      : spaceHeld
        ? "grab"
        : "default";
  };

  const onContext = (e: Event) => e.preventDefault();

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    const oldScale = viewport.scale.x;
    const newScale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, oldScale * Math.exp(-e.deltaY * ZOOM_STEP)),
    );
    const worldX = (lx - viewport.position.x) / oldScale;
    const worldY = (ly - viewport.position.y) / oldScale;
    viewport.scale.set(newScale);
    viewport.position.set(lx - worldX * newScale, ly - worldY * newScale);
    sceneRef.current = { ...sceneRef.current, zoom: newScale };
    syncMouseToViewport();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    panStart = {
      startX: e.clientX,
      startY: e.clientY,
      origX: viewport.position.x,
      origY: viewport.position.y,
    };
    canvas.setPointerCapture(e.pointerId);
    setCursor();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!panStart) return;
    viewport.position.set(
      panStart.origX + (e.clientX - panStart.startX),
      panStart.origY + (e.clientY - panStart.startY),
    );
    syncMouseToViewport();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!panStart) return;
    panStart = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setCursor();
  };

  const isSpaceKey = (e: KeyboardEvent) =>
    e.code === "Space" || e.key === " " || e.key === "Spacebar";
  const onKeyDown = (e: KeyboardEvent) => {
    if (isSpaceKey(e) && !spaceHeld) {
      spaceHeld = true;
      if (e.target === document.body) e.preventDefault();
      setCursor();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (isSpaceKey(e)) {
      spaceHeld = false;
      setCursor();
    }
  };

  const enterPanMode = (e: MouseEvent) => {
    if (panMode) return;
    panMode = true;
    Matter.Composite.remove(engine.world, mouseConstraint);
    app.stage.eventMode = "none";
    panOrigin = {
      startX: e.clientX,
      startY: e.clientY,
      origX: viewport.position.x,
      origY: viewport.position.y,
    };
    setCursor();
  };
  const exitPanMode = () => {
    if (!panMode) return;
    panMode = false;
    panOrigin = null;
    Matter.Composite.add(engine.world, mouseConstraint);
    app.stage.eventMode = stageEventMode;
    setCursor();
  };
  const onPanMove = (ev: MouseEvent) => {
    if (!panMode || !panOrigin) return;
    viewport.position.set(
      panOrigin.origX + (ev.clientX - panOrigin.startX),
      panOrigin.origY + (ev.clientY - panOrigin.startY),
    );
    syncMouseToViewport();
  };
  // Intercept the Space+drag mousedown on window-capture so it runs
  // before Pixi's pointer listeners, then stopImmediatePropagation
  // keeps the gesture from leaking into either library.
  const onMaybeStartPan = (e: MouseEvent) => {
    if (!(e.button === 0 && spaceHeld)) return;
    const tgt = e.target;
    if (!(tgt instanceof Node) || !canvas.contains(tgt)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    enterPanMode(e);
  };

  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMaybeStartPan, { capture: true });
  window.addEventListener("mousemove", onPanMove);
  window.addEventListener("mouseup", exitPanMode);
  window.addEventListener("blur", exitPanMode);

  // ── Sleep/wake ────────────────────────────────────────────────
  let awake = true;
  let sleepFrames = 0;
  const wake = () => {
    awake = true;
    sleepFrames = 0;
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("pointermove", wake);
  window.addEventListener("wheel", wake, { passive: true });
  // Cold-wake warm-up: after a long idle WebKit throttles the main thread, so
  // the first interaction with a slept graph eats the catch-up. Wake on the
  // window-active rising edge so it repaints fresh before the user touches it.
  window.addEventListener("atlas:window-active", wake);

  // ── Per-tick draw ────────────────────────────────────────────
  // When the physics is asleep AND nothing that affects the drawing changed
  // (selection/drag/zoom), skip the whole node+edge+label redraw. Otherwise the
  // graph repaints every node (incl. per-node Pixi text restyle) at display
  // refresh — up to 120 Hz on ProMotion — for a static, idle graph.
  // Every scene mutation (selection, drag, zoom) reassigns `sceneRef.current`
  // to a NEW object; pan only moves the viewport and intentionally does not.
  // So object identity is a complete dirty signal: skip the redraw when the
  // physics is asleep AND the scene object is unchanged.
  let lastScene: typeof sceneRef.current | null = null;
  const tick = (ticker: Ticker) => {
    if (awake) {
      Matter.Engine.update(engine, ticker.deltaMS);
      let total = 0;
      let count = 0;
      for (const node of nodesById.values()) {
        const v = node.body.velocity;
        total += Math.abs(v.x) + Math.abs(v.y);
        count += 1;
      }
      const avg = count > 0 ? total / count : 0;
      if (avg < 0.05) {
        sleepFrames += 1;
        if (sleepFrames > 30) awake = false;
      } else {
        sleepFrames = 0;
      }
    }

    const scene = sceneRef.current;
    if (!awake && scene === lastScene) return;
    lastScene = scene;

    const { selectedId, neighbors, draggingId, draggingNeighbors, zoom } =
      scene;
    // Drag-highlight uses the same visual treatment as selection.
    // Selection wins if both are active.
    const focusId = selectedId ?? draggingId;
    const focusNeighbors = selectedId ? neighbors : draggingNeighbors;
    const hasFocus = focusId !== null;
    const showLabels = zoom >= HIDE_LABEL_BELOW;
    const inv = 1 / zoom; // counter-scale for constant screen-space sizes

    for (const node of nodesById.values()) {
      const isFocused = focusId === node.id;
      const isNeighbor = focusNeighbors.has(node.id);
      let color = COLOR_SECONDARY;
      let alpha = 1;
      let drawRadius = node.radius;
      if (hasFocus) {
        if (isFocused) {
          color = COLOR_PRIMARY;
          drawRadius = node.radius * 1.2;
        } else if (isNeighbor) {
          color = COLOR_PRIMARY;
        } else {
          color = COLOR_MUTED;
          alpha = 0.4;
        }
      }
      node.graphics.clear();
      if (isFocused) {
        node.graphics.circle(
          node.body.position.x,
          node.body.position.y,
          drawRadius + 3 * inv,
        );
        node.graphics.stroke({
          width: 2 * inv,
          color: COLOR_PRIMARY,
          alpha: 0.6,
        });
      }
      node.graphics.circle(
        node.body.position.x,
        node.body.position.y,
        drawRadius,
      );
      node.graphics.fill({ color, alpha });

      // Parallax: counter-scale the label so it stays a constant readable
      // screen size, and keep a constant screen-space gap below the disc.
      node.label.scale.set(inv);
      node.label.position.set(
        node.body.position.x,
        node.body.position.y + drawRadius + LABEL_GAP * inv,
      );
      if (!showLabels) {
        node.label.alpha = 0;
      } else if (!hasFocus) {
        node.label.alpha = 0.85;
        node.label.style = styleFor("#c4c4c4");
      } else if (isFocused || isNeighbor) {
        node.label.alpha = 1;
        node.label.style = styleFor("#fafafa");
      } else {
        node.label.alpha = 0.3;
        node.label.style = styleFor("#5e5e5e");
      }
    }

    for (const edge of edges) {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      edge.graphics.clear();
      if (!a || !b) continue;
      const touchesFocus =
        hasFocus && (focusId === edge.from || focusId === edge.to);
      let color = COLOR_EDGE_DEFAULT;
      let alpha = 0.3;
      if (hasFocus) {
        if (touchesFocus) {
          color = COLOR_EDGE_SELECTED;
          alpha = 0.9;
        } else {
          color = COLOR_EDGE_DIM;
          alpha = 0.15;
        }
      }
      edge.graphics.moveTo(a.body.position.x, a.body.position.y);
      edge.graphics.lineTo(b.body.position.x, b.body.position.y);
      edge.graphics.stroke({
        width: (touchesFocus ? 2 : 1) * inv,
        color,
        alpha,
      });
    }
  };
  app.ticker.add(tick);

  // ── Layout persistence ───────────────────────────────────────
  // Snapshot every node's current world-space position and ship it to
  // the Rust `knowledge_graph_layout_save` command. Debounced so the
  // running simulation doesn't pound disk; one final flush happens on
  // teardown so the latest state survives even short-lived sessions.
  const snapshotLayout = (): GraphLayout => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of nodesById.values()) {
      positions[node.id] = { x: node.body.position.x, y: node.body.position.y };
    }
    return { positions };
  };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      invoke("knowledge_graph_layout_save", {
        projectPath,
        layout: snapshotLayout(),
      }).catch(() => {});
    }, 2000);
  };
  // Save again at most every 2s while the simulation is awake; the
  // tick loop calls scheduleSave (cheap when a timer's already armed).
  Matter.Events.on(engine, "afterUpdate", () => {
    if (sceneRef.current.draggingId !== null) scheduleSave();
  });

  return () => {
    app.ticker.remove(tick);
    // Flush a final snapshot synchronously so unmount doesn't lose
    // unsaved drags.
    if (saveTimer) clearTimeout(saveTimer);
    invoke("knowledge_graph_layout_save", {
      projectPath,
      layout: snapshotLayout(),
    }).catch(() => {});
    canvas.removeEventListener("contextmenu", onContext);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousedown", onMaybeStartPan, true);
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", exitPanMode);
    window.removeEventListener("blur", exitPanMode);
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("pointermove", wake);
    window.removeEventListener("wheel", wake);
    window.removeEventListener("atlas:window-active", wake);
    exitPanMode();
    Matter.Composite.clear(engine.world, false, true);
    Matter.Engine.clear(engine);
  };
}

function LoadingState() {
  return (
    <div className="h-full w-full flex items-center justify-center text-text-tertiary">
      <span className="text-[11px]">Building graph…</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-text-tertiary gap-2">
      <div className="text-[12px]">
        No notes yet — create some and reference them with
      </div>
      <div className="mono text-[11px] text-text-muted">[[note-id]]</div>
      <div className="text-[12px]">to see them connect here.</div>
    </div>
  );
}
