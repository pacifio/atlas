import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  ancestorPath,
  buildMemoryTree,
  elbow,
  initialCollapsed,
  layoutTree,
  parentMap,
  wrapLabel,
  CARD_W,
  CARD_H,
  type TreeNode,
} from "../lib/memory-tree";
import type { MemoryGraphData } from "../lib/memory-graph-types";

interface Props {
  graph: MemoryGraphData;
  projectPath: string;
  selectedId: string | null;
  matchedIds: Set<string>;
  cutoffMs: number | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
}

const MIN_K = 0.4;
const MAX_K = 2.4;
const ZOOM_STEP = 0.0015;

// Monochrome emphasis: `foreground` for the clicked decision path, muted greys
// for everything else (mirrors the Timeline's highlight-and-dim). Every colour
// and font is a token utility on the SVG element, so a theme switch repaints
// through CSS with no subscription.

export function MemoryTreeView({
  graph,
  projectPath,
  selectedId,
  matchedIds,
  cutoffMs,
  onSelect,
}: Props) {
  const rootLabel = useMemo(
    () => projectPath.split("/").filter(Boolean).pop() ?? "memory",
    [projectPath],
  );

  const tree = useMemo(() => buildMemoryTree(graph, rootLabel), [graph, rootLabel]);

  // parentId for every node — drives the ancestor decision-path highlight.
  const parentOf = useMemo(() => parentMap(tree), [tree]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsed(initialCollapsed(tree));
  }, [tree]);

  // When a node is selected, reveal its ancestor chain so the path is visible.
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((s) => {
      let changed = false;
      const n = new Set(s);
      let p = parentOf.get(selectedId);
      while (p) {
        if (n.delete(p)) changed = true;
        p = parentOf.get(p);
      }
      return changed ? n : s;
    });
  }, [selectedId, parentOf]);

  const layout = useMemo(() => layoutTree(tree, collapsed), [tree, collapsed]);

  // Path = selected node + all its ancestors up to the root.
  const pathIds = useMemo(
    () => (selectedId ? ancestorPath(parentOf, selectedId) : null),
    [selectedId, parentOf],
  );

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 28, y: 24, k: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const userMoved = useRef(false);
  const panning = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    userMoved.current = false;
  }, [tree]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      if (userMoved.current) return;
      const h = el.clientHeight;
      const y = Math.max(24, (h - layout.height) / 2);
      setTransform({ x: 28, y, k: 1 });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.height]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const rect = el.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      setTransform((t) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, t.k * Math.exp(-e.deltaY * ZOOM_STEP)));
        const wx = (lx - t.x) / t.k;
        const wy = (ly - t.y) / t.k;
        return { x: lx - wx * k, y: ly - wy * k, k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const dragMoved = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    dragMoved.current = false;
    panning.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panning.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) {
      dragMoved.current = true;
      userMoved.current = true;
    }
    setTransform((t) => ({ ...t, x: p.tx + (e.clientX - p.x), y: p.ty + (e.clientY - p.y) }));
  };
  const onPointerUp = () => {
    panning.current = null;
  };
  // Click on empty canvas (no drag) deselects. Node clicks stopPropagation, so
  // they never reach here.
  const onBackgroundClick = () => {
    if (!dragMoved.current && selectedId) onSelect(null);
  };

  const hasMatches = matchedIds.size > 0;
  const visibleSet = useMemo(() => new Set(layout.visible.map((v) => v.id)), [layout.visible]);

  /** Dim factor for a node id given current path/search/time state. */
  const dimmed = (t: TreeNode): boolean => {
    if (pathIds) return !pathIds.has(t.id);
    if (cutoffMs != null && t.node && t.node.timestampMs > cutoffMs) return true;
    if (hasMatches && t.node) return !matchedIds.has(t.id);
    return false;
  };

  return (
    <div
      ref={wrapRef}
      data-view="memory-tree-view"
      className="absolute inset-0 overflow-hidden cursor-grab active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onClick={onBackgroundClick}
    >
      <svg width="100%" height="100%" className="block select-none">
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {/* Connectors: parent card right edge → child card left edge. */}
          {layout.visible.map((t) => {
            if (collapsed.has(t.id)) return null;
            const p = layout.positions.get(t.id)!;
            return t.children.map((c) => {
              if (!visibleSet.has(c.id)) return null;
              const cp = layout.positions.get(c.id)!;
              const onPath = !!pathIds && pathIds.has(t.id) && pathIds.has(c.id);
              const dim = dimmed(c) && !onPath;
              return (
                <path
                  key={`${t.id}->${c.id}`}
                  d={elbow(p.x + CARD_W, p.y, cp.x, cp.y)}
                  className={cn(
                    "fill-none",
                    onPath ? "stroke-foreground" : "stroke-muted-foreground",
                  )}
                  strokeWidth={onPath ? 1.6 : 1.1}
                  strokeOpacity={onPath ? 0.85 : dim ? 0.08 : 0.4}
                />
              );
            });
          })}

          {/* Nodes — each a fixed-width card so long summaries clamp instead of
              colliding with neighbours. */}
          {layout.visible.map((t) => {
            const p = layout.positions.get(t.id)!;
            const isRoot = t.id === "root";
            const isCat = !t.node && !isRoot;
            const hasKids = t.children.length > 0;
            const onPath = !!pathIds && pathIds.has(t.id);
            const dim = dimmed(t) && !onPath;
            const selected = !!t.node && t.id === selectedId;
            const lit = selected || onPath;
            const opacity = dim ? 0.26 : 1;

            const onNodeDown = (e: React.PointerEvent) => e.stopPropagation();
            const onNodeClick = (e: React.MouseEvent) => {
              e.stopPropagation();
              if (t.node) onSelect(selected ? null : t.id);
              else toggle(t.id);
            };

            return (
              <g
                key={t.id}
                transform={`translate(${p.x} ${p.y - CARD_H / 2})`}
                style={{ cursor: "pointer", opacity }}
                onPointerDown={onNodeDown}
                onClick={onNodeClick}
                onMouseEnter={() => setHoverId(t.id)}
                onMouseLeave={() => setHoverId((h) => (h === t.id ? null : h))}
              >
                {/* Collapse chevron, left of the card. */}
                {hasKids && (
                  <g
                    transform={`translate(-13 ${CARD_H / 2})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(t.id);
                    }}
                  >
                    <rect x={-6} y={-8} width={16} height={16} className="fill-transparent" />
                    <path
                      d={collapsed.has(t.id) ? "M0 -4 L5 0 L0 4 Z" : "M-4 -1.5 L4 -1.5 L0 3.5 Z"}
                      className={lit ? "fill-foreground" : "fill-muted-foreground"}
                    />
                  </g>
                )}
                {(() => {
                  // Wrap maths only: the rendered size is the type-scale class
                  // on `<text>` (`text-xs` 11px, `text-2xs` 10px). The category
                  // row's 10.5 keeps its wrap point; its glyphs round up to 11.
                  const fontPx = isRoot ? 11 : isCat ? 10.5 : 10;
                  const textX = isRoot ? 10 : 20;
                  const maxChars = Math.floor((CARD_W - textX - 9) / (fontPx * 0.54));
                  const suffix =
                    collapsed.has(t.id) && t.children.length > 0 ? `  (${t.children.length})` : "";
                  const lines = wrapLabel(t.label + suffix, maxChars, 3);
                  const lineH = fontPx + 2.5;
                  const top = CARD_H / 2 - ((lines.length - 1) * lineH) / 2;
                  return (
                    <>
                      <rect
                        x={0}
                        y={0}
                        width={CARD_W}
                        height={CARD_H}
                        rx={6}
                        className={
                          lit
                            ? "fill-element-selected stroke-foreground"
                            : isRoot || t.id === hoverId
                              ? "fill-card stroke-border-strong"
                              : "fill-card stroke-border"
                        }
                        strokeWidth={1}
                      />
                      {!isRoot && (
                        <circle
                          cx={12}
                          cy={CARD_H / 2}
                          r={2.5}
                          className={lit ? "fill-foreground" : "fill-muted-foreground"}
                          fillOpacity={isCat ? 0.9 : 0.7}
                        />
                      )}
                      <text
                        x={textX}
                        // The type scale's two weights: 400 disappears
                        // against the dense monochrome chrome.
                        className={cn(
                          "font-sans",
                          isRoot || isCat ? "font-semibold text-xs" : "font-medium text-2xs",
                          lit ? "fill-foreground" : "fill-secondary-foreground",
                        )}
                      >
                        {lines.map((ln, i) => (
                          <tspan key={i} x={textX} y={top + i * lineH} dominantBaseline="middle">
                            {ln}
                          </tspan>
                        ))}
                      </text>
                    </>
                  );
                })()}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );

  function toggle(id: string) {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
}
