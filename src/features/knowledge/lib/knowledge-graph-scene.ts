/**
 * The knowledge graph's pixi + Matter scene: physics, layers, pan/zoom,
 * sleep/wake and the per-tick draw. No React, no IPC, no store — the canvas
 * host owns the pixi `Application` lifecycle and hands this the callbacks.
 *
 * Obsidian-style force-directed graph. Pixi is driven imperatively (not via
 * @pixi/react) because @pixi/react@8 augments React's JSX namespace globally
 * and breaks unrelated component typing in Atlas.
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
import {
  DOUBLE_CLICK_MS,
  HIDE_LABEL_BELOW,
  LABEL_GAP,
  MAX_SCALE,
  MIN_SCALE,
  RESOLUTION,
  ZOOM_STEP,
  neighborsOf,
  nodeRadiusForDegree,
  type GraphLayout,
  type ProjectGraph,
} from "./knowledge-graph-model";

export interface KnowledgeSceneState {
  selectedId: string | null;
  neighbors: Set<string>;
  /** Body the user is currently dragging — treated as a transient
   *  highlight so edges + neighbours light up live, not on release. */
  draggingId: string | null;
  draggingNeighbors: Set<string>;
  zoom: number;
  /** Resolved theme colours. Swapped wholesale on `atlas:theme-applied`. */
  palette: GraphPalette;
}

export interface KnowledgeSceneOptions {
  graph: ProjectGraph;
  width: number;
  height: number;
  /** Every scene mutation assigns a NEW object here — that is the dirty signal. */
  sceneRef: { current: KnowledgeSceneState };
  initialLayout: GraphLayout;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  onViewport: (v: Viewport) => void;
  /** Debounced 2 s while dragging, and once on teardown. */
  onLayoutChange: (layout: GraphLayout) => void;
  /** The UI font, read once: pixi rasterises each label a single time. */
  labelFontFamily: string;
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

/**
 * Builds the scene graph + Matter world + per-tick draw loop.
 * Returns a teardown function the caller invokes on unmount.
 */
export function buildKnowledgeScene(app: Application, opts: KnowledgeSceneOptions): () => void {
  const { graph, width, height, sceneRef, initialLayout, onSelect, onActivate, onViewport } = opts;
  // ── Physics ──────────────────────────────────────────────────
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

  // ── Initial layout ───────────────────────────────────────────
  const nodesById = new Map<string, NodeView>();
  const cx = width / 2;
  const cy = height / 2;

  // Obsidian-style spider seed: force-directed initial positions so hubs sit
  // central and leaves fan out, instead of a flat ring. Saved layouts win.
  const seedMap = forceLayout(
    graph.nodes.map((nd) => ({ id: nd.id, degree: nd.inDegree + nd.outDegree })),
    graph.edges,
    width,
    height,
  );

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

    const label = new Text({
      text: node.title,
      style: styleFor(sceneRef.current.palette.labelSecondary),
    });
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
  Matter.Events.on(mouseConstraint, "startdrag", (ev: Matter.IEvent<Matter.MouseConstraint>) => {
    const dragged = (ev as unknown as { body?: Matter.Body }).body;
    if (!dragged) return;
    for (const node of nodesById.values()) {
      if (node.body !== dragged) continue;
      sceneRef.current = {
        ...sceneRef.current,
        draggingId: node.id,
        draggingNeighbors: neighborsOf(node.id, graph.edges),
      };
      break;
    }
  });
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
  let lastScene: KnowledgeSceneState | null = null;
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

    const { selectedId, neighbors, draggingId, draggingNeighbors, zoom, palette } = scene;
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
      let color = palette.secondary;
      let alpha = 1;
      let drawRadius = node.radius;
      if (hasFocus) {
        if (isFocused) {
          color = palette.primary;
          drawRadius = node.radius * 1.2;
        } else if (isNeighbor) {
          color = palette.primary;
        } else {
          color = palette.muted;
          alpha = 0.4;
        }
      }
      node.graphics.clear();
      if (isFocused) {
        node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius + 3 * inv);
        node.graphics.stroke({ width: 2 * inv, color: palette.primary, alpha: 0.6 });
      }
      node.graphics.circle(node.body.position.x, node.body.position.y, drawRadius);
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
        node.label.style = styleFor(palette.labelSecondary);
      } else if (isFocused || isNeighbor) {
        node.label.alpha = 1;
        node.label.style = styleFor(palette.labelPrimary);
      } else {
        node.label.alpha = 0.3;
        node.label.style = styleFor(palette.labelMuted);
      }
    }

    for (const edge of edges) {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      edge.graphics.clear();
      if (!a || !b) continue;
      const touchesFocus = hasFocus && (focusId === edge.from || focusId === edge.to);
      let color = palette.edgeDefault;
      let alpha = 0.3;
      if (hasFocus) {
        if (touchesFocus) {
          color = palette.edgeSelected;
          alpha = 0.9;
        } else {
          color = palette.edgeDim;
          alpha = 0.15;
        }
      }
      edge.graphics.moveTo(a.body.position.x, a.body.position.y);
      edge.graphics.lineTo(b.body.position.x, b.body.position.y);
      edge.graphics.stroke({ width: (touchesFocus ? 2 : 1) * inv, color, alpha });
    }
  };
  app.ticker.add(tick);

  // ── Layout persistence ───────────────────────────────────────
  // Snapshot every node's current world-space position and hand it to
  // `onLayoutChange`. Debounced so a drag doesn't pound disk; one final
  // flush happens on teardown so the latest state survives even
  // short-lived sessions.
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
      opts.onLayoutChange(snapshotLayout());
    }, 2000);
  };
  // Save again at most every 2s while a node is dragged; the physics
  // step calls scheduleSave (cheap when a timer's already armed).
  Matter.Events.on(engine, "afterUpdate", () => {
    if (sceneRef.current.draggingId !== null) scheduleSave();
  });

  return () => {
    app.ticker.remove(tick);
    // Flush a final snapshot synchronously so unmount doesn't lose
    // unsaved drags.
    if (saveTimer) clearTimeout(saveTimer);
    opts.onLayoutChange(snapshotLayout());
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
