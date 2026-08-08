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

/**
 * Force-directed memory graph — a self-contained sibling of the knowledge
 * graph (same Pixi+Matter engine and WKWebView hardening) parameterized on
 * generic memory nodes/edges. Query matches light up; selection dims the rest.
 * Deliberately NOT a refactor of `knowledge-graph.tsx`, to avoid regressing it.
 */

export interface MemoryNode {
  id: string;
  title: string;
  /** Natural-language one-liner for display (falls back to title). */
  summary: string;
  kind: string;
  source: string; // "claude" | "codex"
  snippet: string;
  degree: number;
  timestampMs: number;
}
export interface MemoryEdge {
  // Oriented older → newer: `from` plausibly influenced `to`.
  from: string;
  to: string;
  kind: string; // "similarity" | "link"
}
export interface MemoryGraphData {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}
interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
}

const RESOLUTION = 2;
const COLOR_PRIMARY = 0xfafafa;
const COLOR_SECONDARY = 0xc4c4c4;
const COLOR_MUTED = 0x5e5e5e;
const COLOR_EDGE_DEFAULT = 0x333333;
const COLOR_EDGE_SELECTED = 0xc4c4c4;
const COLOR_EDGE_DIM = 0x262626;
const COLOR_EDGE_LINK = 0x4a4a4a;
const COLOR_ANCESTOR = 0x6796e6; // "influenced this" — cool tint, upstream in time
const COLOR_IMPACT = 0xfafafa; // "this influenced" — bright, downstream in time
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
  ts: number;
  recency: number; // 0 (oldest) … 1 (newest)
}
interface EdgeView {
  from: string;
  to: string;
  kind: string;
  graphics: Graphics;
}
interface SceneState {
  selectedId: string | null;
  /** Forward time-reachable from the selection — what it influenced. */
  impact: Set<string>;
  /** Backward time-reachable — what influenced the selection. */
  ancestors: Set<string>;
  matched: Set<string>;
  draggingId: string | null;
  draggingNeighbors: Set<string>;
  /** Hide memories created after this instant (time scrubber). null = show all. */
  cutoff: number | null;
  zoom: number;
}

export function MemoryGraphCanvas({
  graph,
  projectPath,
  selectedId,
  matchedIds,
  cutoffMs,
  onSelect,
  onActivate,
}: {
  graph: MemoryGraphData;
  projectPath: string;
  selectedId: string | null;
  matchedIds: Set<string>;
  cutoffMs: number | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<GraphLayout | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void invoke<GraphLayout>("memory_graph_layout_load", { projectPath })
      .then((l) => {
        if (!cancelled) setLayout(l ?? { positions: {} });
      })
      .catch(() => {
        if (!cancelled) setLayout({ positions: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      setSize({
        width: Math.max(200, Math.floor(width)),
        height: Math.max(200, Math.floor(height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative"
      style={{ background: "var(--bg-canvas, var(--bg-base))" }}
    >
      {size.width > 0 && size.height > 0 && layout !== undefined && (
        <Scene
          graph={graph}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          matchedIds={matchedIds}
          cutoffMs={cutoffMs}
          onSelect={onSelect}
          onActivate={onActivate}
          initialLayout={layout}
          projectPath={projectPath}
        />
      )}
    </div>
  );
}

function Scene({
  graph,
  width,
  height,
  selectedId,
  matchedIds,
  cutoffMs,
  onSelect,
  onActivate,
  initialLayout,
  projectPath,
}: {
  graph: MemoryGraphData;
  width: number;
  height: number;
  selectedId: string | null;
  matchedIds: Set<string>;
  cutoffMs: number | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  initialLayout: GraphLayout;
  projectPath: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRafRef = useRef(false);
  const sceneRef = useRef<SceneState>({
    selectedId,
    impact: new Set(),
    ancestors: new Set(),
    matched: matchedIds,
    draggingId: null,
    draggingNeighbors: new Set(),
    cutoff: cutoffMs,
    zoom: 1,
  });

  // Forward/backward adjacency (edges are oriented older → newer).
  const adj = useMemo(() => {
    const fwd = new Map<string, string[]>();
    const bwd = new Map<string, string[]>();
    for (const e of graph.edges) {
      (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
      (bwd.get(e.to) ?? bwd.set(e.to, []).get(e.to)!).push(e.from);
    }
    return { fwd, bwd };
  }, [graph.edges]);

  // On selection, compute the impact cone (everything reachable forward in
  // time) and the ancestor set (everything that fed into it). The time DAG has
  // no cycles, so this terminates.
  useEffect(() => {
    const reach = (start: string, m: Map<string, string[]>): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nxt of m.get(cur) ?? []) {
          if (!seen.has(nxt)) {
            seen.add(nxt);
            stack.push(nxt);
          }
        }
      }
      return seen;
    };
    const impact = selectedId ? reach(selectedId, adj.fwd) : new Set<string>();
    const ancestors = selectedId ? reach(selectedId, adj.bwd) : new Set<string>();
    sceneRef.current = { ...sceneRef.current, selectedId, impact, ancestors };
  }, [selectedId, adj]);

  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, matched: matchedIds };
  }, [matchedIds]);

  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, cutoff: cutoffMs };
  }, [cutoffMs]);

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
        /* disposal handles fallout */
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

function buildScene(
  app: Application,
  graph: MemoryGraphData,
  width: number,
  height: number,
  sceneRef: React.MutableRefObject<SceneState>,
  onSelect: (id: string | null) => void,
  onActivate: (id: string) => void,
  initialLayout: GraphLayout,
  projectPath: string,
  onViewport: (v: Viewport) => void,
): () => void {
  const engine = Matter.Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;
  engine.constraintIterations = 7;

  const walls = [
    Matter.Bodies.rectangle(width / 2, height + 50, width + 200, 100, { isStatic: true }),
    Matter.Bodies.rectangle(width / 2, -50, width + 200, 100, { isStatic: true }),
    Matter.Bodies.rectangle(-50, height / 2, 100, height + 200, { isStatic: true }),
    Matter.Bodies.rectangle(width + 50, height / 2, 100, height + 200, { isStatic: true }),
  ];
  Matter.Composite.add(engine.world, walls);

  const viewport = new Container();
  app.stage.addChild(viewport);
  const bgHit = new Graphics();
  bgHit.rect(-1e5, -1e5, 2e5, 2e5).fill({ color: 0x000000, alpha: 0 });
  bgHit.eventMode = "static";
  bgHit.on("pointertap", () => onSelect(null));
  viewport.addChild(bgHit);

  const edgeLayer = new Container();
  const nodeLayer = new Container();
  const labelLayer = new Container();
  viewport.addChild(edgeLayer, nodeLayer, labelLayer);

  const nodesById = new Map<string, NodeView>();
  const cx = width / 2;
  const cy = height / 2;

  // Obsidian-style spider seed: force-directed initial positions so hubs sit
  // central and leaves fan out, instead of a flat ring. Saved layouts win.
  const seedMap = forceLayout(
    graph.nodes.map((nd) => ({ id: nd.id, degree: nd.degree })),
    graph.edges,
    width,
    height,
  );

  // Recency normalization over known timestamps (ignore 0 / unknown).
  const knownTs = graph.nodes.map((g) => g.timestampMs).filter((t) => t > 0);
  const minTs = knownTs.length ? Math.min(...knownTs) : 0;
  const maxTs = knownTs.length ? Math.max(...knownTs) : 0;
  const recencyOf = (ts: number): number => {
    if (ts <= 0 || maxTs <= minTs) return 0.5;
    return (ts - minTs) / (maxTs - minTs);
  };

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
    const saved = initialLayout.positions[node.id];
    const seed = seedMap[node.id];
    const x = saved ? saved.x : seed ? seed.x : cx;
    const y = saved ? saved.y : seed ? seed.y : cy;
    const radius = nodeRadiusForDegree(node.degree);
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

    const label = new Text({ text: node.summary || node.title, style: styleFor("#c4c4c4") });
    label.anchor.set(0.5, 0); // top-center: hangs below the disc
    labelLayer.addChild(label);

    nodesById.set(node.id, {
      id: node.id,
      body,
      radius,
      graphics,
      label,
      ts: node.timestampMs,
      recency: recencyOf(node.timestampMs),
    });
  });

  const edges: EdgeView[] = graph.edges.map((e) => {
    const g = new Graphics();
    edgeLayer.addChild(g);
    return { from: e.from, to: e.to, kind: e.kind, graphics: g };
  });

  const mouse = Matter.Mouse.create(app.canvas as HTMLCanvasElement);
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: {
      stiffness: 0.2,
      render: { visible: false } as Matter.IConstraintRenderDefinition,
    },
  });
  Matter.Composite.add(engine.world, mouseConstraint);

  const syncMouseToViewport = () => {
    const z = viewport.scale.x;
    const s = 1 / (RESOLUTION * z);
    Matter.Mouse.setScale(mouse, { x: s, y: s });
    Matter.Mouse.setOffset(mouse, { x: -viewport.position.x / z, y: -viewport.position.y / z });
    onViewport({ x: viewport.position.x, y: viewport.position.y, scale: z });
  };
  syncMouseToViewport();

  Matter.Events.on(mouseConstraint, "startdrag", (ev: Matter.IEvent<Matter.MouseConstraint>) => {
    const dragged = (ev as unknown as { body?: Matter.Body }).body;
    if (!dragged) return;
    for (const node of nodesById.values()) {
      if (node.body !== dragged) continue;
      const ns = new Set<string>();
      for (const e of graph.edges) {
        if (e.from === node.id) ns.add(e.to);
        else if (e.to === node.id) ns.add(e.from);
      }
      sceneRef.current = { ...sceneRef.current, draggingId: node.id, draggingNeighbors: ns };
      break;
    }
  });
  Matter.Events.on(mouseConstraint, "enddrag", () => {
    sceneRef.current = { ...sceneRef.current, draggingId: null, draggingNeighbors: new Set() };
  });

  let panStart: { startX: number; startY: number; origX: number; origY: number } | null = null;
  let panMode = false;
  let panOrigin: { startX: number; startY: number; origX: number; origY: number } | null = null;
  let spaceHeld = false;
  const stageEventMode = app.stage.eventMode;
  const canvas = app.canvas as HTMLCanvasElement;

  const setCursor = () => {
    const grabbing = panStart !== null || panMode;
    canvas.style.cursor = grabbing ? "grabbing" : spaceHeld ? "grab" : "default";
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

  let awake = true;
  let sleepFrames = 0;
  const wake = () => {
    awake = true;
    sleepFrames = 0;
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("pointermove", wake);
  window.addEventListener("wheel", wake, { passive: true });
  // Cold-wake warm-up: repaint fresh on the window-active rising edge so a
  // slept graph isn't caught by WebKit's post-idle throttle on first touch.
  window.addEventListener("atlas:window-active", wake);

  // Every scene mutation (selection, search, timeline cutoff, drag, zoom)
  // reassigns `sceneRef.current` to a NEW object; pan only moves the viewport
  // and intentionally does not. So object identity is a complete dirty signal:
  // skip the full node+edge+label redraw when the physics is asleep AND the
  // scene object is unchanged (a static idle graph otherwise repaints every
  // node — incl. per-node Pixi text restyle — at up to 120 Hz).
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
      } else sleepFrames = 0;
    }

    const scene = sceneRef.current;
    if (!awake && scene === lastScene) return;
    lastScene = scene;

    const { selectedId, impact, ancestors, matched, draggingId, draggingNeighbors, cutoff, zoom } =
      scene;
    const hasSelection = selectedId !== null;
    const hasDrag = !hasSelection && draggingId !== null;
    const hasMatches = !hasSelection && !hasDrag && matched.size > 0;
    const showLabels = zoom >= HIDE_LABEL_BELOW;
    const inv = 1 / zoom; // counter-scale for constant screen-space sizes
    const isFuture = (ts: number) => cutoff !== null && ts > 0 && ts > cutoff;

    for (const node of nodesById.values()) {
      const future = isFuture(node.ts);
      let color = COLOR_SECONDARY;
      let alpha = 1;
      let drawRadius = node.radius;
      let ring = false;
      let lit = false;
      let labelDim = false;

      if (future) {
        // Not yet "born" at the scrubber's instant.
        color = COLOR_MUTED;
        alpha = 0.05;
        labelDim = true;
      } else if (hasSelection) {
        if (node.id === selectedId) {
          color = COLOR_IMPACT;
          drawRadius = node.radius * 1.25;
          ring = true;
          lit = true;
        } else if (impact.has(node.id)) {
          color = COLOR_IMPACT;
          lit = true;
        } else if (ancestors.has(node.id)) {
          color = COLOR_ANCESTOR;
          alpha = 0.95;
          lit = true;
        } else {
          color = COLOR_MUTED;
          alpha = 0.28;
          labelDim = true;
        }
      } else if (hasDrag) {
        if (node.id === draggingId) {
          color = COLOR_PRIMARY;
          ring = true;
          lit = true;
        } else if (draggingNeighbors.has(node.id)) {
          color = COLOR_PRIMARY;
          lit = true;
        } else {
          color = COLOR_MUTED;
          alpha = 0.4;
          labelDim = true;
        }
      } else if (hasMatches) {
        if (matched.has(node.id)) {
          color = COLOR_PRIMARY;
          drawRadius = node.radius * 1.15;
          ring = true;
          lit = true;
        } else {
          color = COLOR_MUTED;
          alpha = 0.35;
          labelDim = true;
        }
      } else {
        // Neutral: brightness grades with recency (newer = brighter).
        color = COLOR_SECONDARY;
        alpha = 0.5 + 0.5 * node.recency;
      }

      node.graphics.clear();
      if (ring) {
        node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius + 3 * inv);
        node.graphics.stroke({ width: 2 * inv, color, alpha: 0.6 });
      }
      node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius);
      node.graphics.fill({ color, alpha });

      // Parallax: counter-scale the label so it stays a constant readable
      // screen size, with a constant screen-space gap below the disc.
      node.label.scale.set(inv);
      node.label.position.set(
        node.body.position.x,
        node.body.position.y + drawRadius + LABEL_GAP * inv,
      );
      if (!showLabels || future) node.label.alpha = 0;
      else if (!hasSelection && !hasDrag && !hasMatches) {
        node.label.alpha = 0.85;
        node.label.style = styleFor("#c4c4c4");
      } else if (lit) {
        node.label.alpha = 1;
        node.label.style = styleFor("#fafafa");
      } else if (labelDim) {
        node.label.alpha = 0.25;
        node.label.style = styleFor("#5e5e5e");
      } else {
        node.label.alpha = 0.6;
        node.label.style = styleFor("#c4c4c4");
      }
    }

    const litFwd = (id: string) => id === selectedId || impact.has(id);
    const litBwd = (id: string) => id === selectedId || ancestors.has(id);

    for (const edge of edges) {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      edge.graphics.clear();
      if (!a || !b) continue;
      if (isFuture(a.ts) || isFuture(b.ts)) {
        // One endpoint not born yet — keep faint.
        edge.graphics.moveTo(a.body.position.x, a.body.position.y);
        edge.graphics.lineTo(b.body.position.x, b.body.position.y);
        edge.graphics.stroke({ width: 1 * inv, color: COLOR_EDGE_DIM, alpha: 0.04 });
        continue;
      }

      let color = edge.kind === "link" ? COLOR_EDGE_LINK : COLOR_EDGE_DEFAULT;
      let alpha = edge.kind === "link" ? 0.5 : 0.3;
      let arrow: number | null = null; // arrowhead color when on an influence path

      if (hasSelection) {
        if (litFwd(edge.from) && litFwd(edge.to)) {
          color = COLOR_IMPACT;
          alpha = 0.85;
          arrow = COLOR_IMPACT;
        } else if (litBwd(edge.from) && litBwd(edge.to)) {
          color = COLOR_ANCESTOR;
          alpha = 0.7;
          arrow = COLOR_ANCESTOR;
        } else {
          color = COLOR_EDGE_DIM;
          alpha = 0.12;
        }
      } else if (hasDrag) {
        const touches = edge.from === draggingId || edge.to === draggingId;
        if (touches) {
          color = COLOR_EDGE_SELECTED;
          alpha = 0.9;
        } else {
          color = COLOR_EDGE_DIM;
          alpha = 0.15;
        }
      } else if (hasMatches) {
        alpha = 0.12;
      }

      const ax = a.body.position.x;
      const ay = a.body.position.y;
      const bx = b.body.position.x;
      const by = b.body.position.y;
      edge.graphics.moveTo(ax, ay);
      edge.graphics.lineTo(bx, by);
      edge.graphics.stroke({ width: (arrow !== null ? 1.5 : 1) * inv, color, alpha });

      if (arrow !== null) {
        // Arrowhead just outside the target node, pointing older → newer.
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tipX = bx - ux * (b.radius + 2 * inv);
        const tipY = by - uy * (b.radius + 2 * inv);
        const size = 6 * inv;
        const leftX = tipX - ux * size - uy * size * 0.6;
        const leftY = tipY - uy * size + ux * size * 0.6;
        const rightX = tipX - ux * size + uy * size * 0.6;
        const rightY = tipY - uy * size - ux * size * 0.6;
        edge.graphics.moveTo(tipX, tipY);
        edge.graphics.lineTo(leftX, leftY);
        edge.graphics.lineTo(rightX, rightY);
        edge.graphics.lineTo(tipX, tipY);
        edge.graphics.fill({ color: arrow, alpha });
      }
    }
  };
  app.ticker.add(tick);

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
      invoke("memory_graph_layout_save", { projectPath, layout: snapshotLayout() }).catch(() => {});
    }, 2000);
  };
  Matter.Events.on(engine, "afterUpdate", () => {
    if (sceneRef.current.draggingId !== null) scheduleSave();
  });

  return () => {
    app.ticker.remove(tick);
    if (saveTimer) clearTimeout(saveTimer);
    invoke("memory_graph_layout_save", { projectPath, layout: snapshotLayout() }).catch(() => {});
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
