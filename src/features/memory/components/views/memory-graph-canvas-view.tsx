import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Application } from "pixi.js";
import { destroyPixiApp, registerPixiApp } from "@/lib/pixi-app";
import { GraphRuler, type Viewport } from "@/components/graph-ruler";
import { graphPalette } from "@/components/graph-palette";
import { onThemeApplied, themeBase } from "@/features/theme/theme-values";
import type { GraphLayout, MemoryGraphData } from "../../lib/memory-graph-types";
import { buildAdjacency, reachable } from "../../lib/memory-graph-paint";
import { buildMemoryScene, RESOLUTION, type MemorySceneState } from "../../lib/memory-graph-scene";

/**
 * The memory force graph: sizes itself, owns the pixi `Application` and feeds
 * selection / search / timeline state into the scene. Props only — the
 * container (`memory-graph-canvas.tsx`) loads and saves the layout.
 */
export function MemoryGraphCanvasView({
  graph,
  initialLayout,
  selectedId,
  matchedIds,
  cutoffMs,
  onSelect,
  onActivate,
  onLayoutSave,
}: {
  graph: MemoryGraphData;
  initialLayout: GraphLayout;
  selectedId: string | null;
  matchedIds: Set<string>;
  cutoffMs: number | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  onLayoutSave: (layout: GraphLayout) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

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
      data-view="memory-graph-canvas"
      className="relative h-full w-full bg-panel"
    >
      {size.width > 0 && size.height > 0 && (
        <Scene
          graph={graph}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          matchedIds={matchedIds}
          cutoffMs={cutoffMs}
          onSelect={onSelect}
          onActivate={onActivate}
          initialLayout={initialLayout}
          onLayoutSave={onLayoutSave}
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
  onLayoutSave,
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
  onLayoutSave: (layout: GraphLayout) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRef = useRef<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpRafRef = useRef(false);
  const sceneRef = useRef<MemorySceneState>({
    selectedId,
    impact: new Set(),
    ancestors: new Set(),
    matched: matchedIds,
    draggingId: null,
    draggingNeighbors: new Set(),
    cutoff: cutoffMs,
    zoom: 1,
    palette: graphPalette(),
  });

  // WebGL cannot inherit a CSS custom property, so a theme switch has to push a
  // new palette in and force one more frame — replacing the scene OBJECT is
  // what does the forcing, since the ticker early-outs on `scene === lastScene`
  // once the simulation has settled.
  useEffect(
    () =>
      onThemeApplied(() => {
        sceneRef.current = { ...sceneRef.current, palette: graphPalette() };
      }),
    [],
  );

  const adj = useMemo(() => buildAdjacency(graph.edges), [graph.edges]);

  // On selection, compute the impact cone (everything reachable forward in
  // time) and the ancestor set (everything that fed into it).
  useEffect(() => {
    const impact = selectedId ? reachable(selectedId, adj.fwd) : new Set<string>();
    const ancestors = selectedId ? reachable(selectedId, adj.bwd) : new Set<string>();
    sceneRef.current = { ...sceneRef.current, selectedId, impact, ancestors };
  }, [selectedId, adj]);

  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, matched: matchedIds };
  }, [matchedIds]);

  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, cutoff: cutoffMs };
  }, [cutoffMs]);

  // No Esc listener here: `MemoryGraphView` owns Esc-to-deselect, and skips it
  // while a field has focus, so Esc in the search box only clears the search.

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let teardown: (() => void) | null = null;
    let createdApp: Application | null = null;

    // Canvas built imperatively each mount so React StrictMode's double-mount
    // can't hand a half-destroyed WebGL canvas to a fresh Pixi Application.
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const app = new Application();
    registerPixiApp(app);
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
            destroyPixiApp(app);
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
        teardown = buildMemoryScene(app, {
          graph,
          width,
          height,
          sceneRef,
          initialLayout,
          onSelect,
          onActivate,
          onViewport: pushViewport,
          onLayoutSave,
          labelFontFamily: themeBase("font-sans") || "system-ui, sans-serif",
        });
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
          destroyPixiApp(createdApp);
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
    // A resize rebuilds the app; callbacks are captured as of the build.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, width, height]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      <GraphRuler width={width} height={height} viewport={viewport} />
    </div>
  );
}
