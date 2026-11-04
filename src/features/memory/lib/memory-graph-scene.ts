/**
 * The memory graph's pixi + Matter scene: physics, layers, pan/zoom, sleep/wake
 * and the per-tick draw. No React, no IPC, no store — the host component owns
 * the pixi `Application` lifecycle and hands this the callbacks.
 *
 * A self-contained sibling of the knowledge graph's scene (same Pixi+Matter
 * engine and WKWebView hardening) parameterized on generic memory nodes/edges.
 * Deliberately NOT shared with it, to avoid regressing either.
 */
import {
  Container,
  Graphics,
  Text,
  TextStyle,
  type Application,
  type Ticker,
  type FederatedPointerEvent,
} from "pixi.js";
import Matter from "matter-js";
import { forceLayout } from "@/lib/graph-layout";
import type { Viewport } from "@/components/graph-ruler";
import type { GraphPalette } from "@/components/graph-palette";
import type { GraphLayout, MemoryGraphData } from "./memory-graph-types";
import {
  arrowHead,
  makeRecency,
  nodeRadiusForDegree,
  paintEdge,
  paintNode,
  type LabelTone,
  type PaintState,
} from "./memory-graph-paint";

/** Pixi's backing-store resolution; the host passes it to `app.init`. */
export const RESOLUTION = 2;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.004;
const DOUBLE_CLICK_MS = 280;
/** Constant screen-px gap between a node's disc and its label (counter-scaled). */
const LABEL_GAP = 6;

export interface MemorySceneState extends PaintState {
  /** Resolved theme colours. Swapped wholesale on `atlas:theme-applied`. */
  palette: GraphPalette;
}

export interface MemorySceneOptions {
  graph: MemoryGraphData;
  width: number;
  height: number;
  /** Every scene mutation assigns a NEW object here — that is the dirty signal. */
  sceneRef: { current: MemorySceneState };
  initialLayout: GraphLayout;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  onViewport: (v: Viewport) => void;
  /** Debounced 2 s while dragging, and once on teardown. */
  onLayoutSave: (layout: GraphLayout) => void;
  labelFontFamily: string;
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

/** Builds the scene graph + Matter world + per-tick draw loop. Returns the
 *  teardown the host calls on unmount. */
export function buildMemoryScene(app: Application, opts: MemorySceneOptions): () => void {
  const { graph, width, height, sceneRef, initialLayout, onSelect, onActivate, onViewport } = opts;
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
  const recencyOf = makeRecency(graph.nodes);

  const labelStyles = new Map<string, TextStyle>();
  const styleFor = (fill: string): TextStyle => {
    let s = labelStyles.get(fill);
    if (!s) {
      s = new TextStyle({
        fontFamily: opts.labelFontFamily,
        // pixi rasterises label text into a WebGL atlas.
        // ratchet-allow: TextStyle takes a number, and no CSS is in this path.
        fontSize: 11,
        fontWeight: "500",
        fill,
        align: "center",
      });
      labelStyles.set(fill, s);
    }
    return s;
  };
  const labelFill = (tone: LabelTone, palette: GraphPalette): string =>
    tone === "primary"
      ? palette.labelPrimary
      : tone === "muted"
        ? palette.labelMuted
        : palette.labelSecondary;

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

    const label = new Text({
      text: node.summary || node.title,
      style: styleFor(sceneRef.current.palette.labelSecondary),
    });
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

  const canvas = app.canvas as HTMLCanvasElement;
  // Matter computes `position = absolute * (canvas.width / clientWidth) * scale
  // + offset`. Bodies live in CSS px, and the pixi viewport pans/zooms them, so
  // we want `world = (canvas - viewportPos) / viewportScale`, i.e.
  // `scale = 1 / (ratio * z)`, `offset = -viewportPos / z`. The ratio is the
  // MEASURED backing ratio, not `RESOLUTION`, because Matter measures it too.
  // Call this after every viewport change so picking stays aligned.
  const syncMouseToViewport = () => {
    const z = viewport.scale.x;
    // A hidden canvas measures 0 wide; fall back rather than divide by it.
    const ratio = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : RESOLUTION;
    const s = 1 / (ratio * z);
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
  let lastScene: MemorySceneState | null = null;
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

    const { palette } = scene;
    const inv = 1 / scene.zoom; // counter-scale for constant screen-space sizes

    for (const node of nodesById.values()) {
      const p = paintNode(node, scene, palette);
      const { x, y } = node.body.position;
      const drawRadius = node.radius * p.radiusScale;
      node.graphics.clear();
      if (p.ring) {
        node.graphics.circle(x, y, drawRadius + 3 * inv);
        node.graphics.stroke({ width: 2 * inv, color: p.color, alpha: 0.6 });
      }
      node.graphics.circle(x, y, drawRadius);
      node.graphics.fill({ color: p.color, alpha: p.alpha });

      // Parallax: counter-scale the label so it stays a constant readable
      // screen size, with a constant screen-space gap below the disc.
      node.label.scale.set(inv);
      node.label.position.set(x, y + drawRadius + LABEL_GAP * inv);
      node.label.alpha = p.label.alpha;
      if (p.label.visible) node.label.style = styleFor(labelFill(p.label.tone, palette));
    }

    for (const edge of edges) {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      edge.graphics.clear();
      if (!a || !b) continue;
      const p = paintEdge(edge, a.ts, b.ts, scene, palette);
      const { x: ax, y: ay } = a.body.position;
      const { x: bx, y: by } = b.body.position;
      edge.graphics.moveTo(ax, ay);
      edge.graphics.lineTo(bx, by);
      edge.graphics.stroke({ width: p.width * inv, color: p.color, alpha: p.alpha });

      if (p.arrow !== null) {
        const [tipX, tipY, leftX, leftY, rightX, rightY] = arrowHead(ax, ay, bx, by, b.radius, inv);
        edge.graphics.moveTo(tipX, tipY);
        edge.graphics.lineTo(leftX, leftY);
        edge.graphics.lineTo(rightX, rightY);
        edge.graphics.lineTo(tipX, tipY);
        edge.graphics.fill({ color: p.arrow, alpha: p.alpha });
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
      opts.onLayoutSave(snapshotLayout());
    }, 2000);
  };
  Matter.Events.on(engine, "afterUpdate", () => {
    if (sceneRef.current.draggingId !== null) scheduleSave();
  });

  return () => {
    app.ticker.remove(tick);
    if (saveTimer) clearTimeout(saveTimer);
    opts.onLayoutSave(snapshotLayout());
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
