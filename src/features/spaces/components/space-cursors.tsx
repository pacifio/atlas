import { useEffect, useRef } from "react";
import { ViewportPortal } from "@xyflow/react";
import { MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SpaceActor } from "../lib/space-wire";

/**
 * Remote cursors, interpolated.
 *
 * The network delivers positions at ~20Hz (50ms publish throttle × 50ms
 * server fanout tick); painted raw, a peer's cursor teleports twenty times a
 * second. Here render rate is decoupled from network rate: React owns
 * existence and identity (mount/unmount, colour, name pill), while a rAF
 * loop owns POSITION imperatively — each frame every cursor glides toward
 * its latest known target with time-based exponential smoothing, and the
 * element's transform is mutated directly. No React state per frame: a 60Hz
 * setState for N cursors is exactly the high-rate-data-through-the-store
 * mistake the comms buses exist to avoid.
 *
 * The loop is strictly demand-driven — it stops the moment every cursor is
 * within ε of its target and restarts only when a new position arrives, so
 * a still room costs zero. Interpolation happens in CANVAS coordinates
 * inside the ViewportPortal; pan/zoom multiplies on top untouched.
 */

/** Smoothing time-constant: ~95% of the way in ~3τ ≈ 270ms — reads as glide
 *  across a 50ms tick gap without feeling like lag. */
const TAU_MS = 90;
/** Settled when this close (canvas px) — below any visible sub-pixel. */
const EPSILON = 0.3;
/** A frame gap this long means the webview was throttled/hidden (WKWebView
 *  pauses rAF): snap rather than replay a long glide on refocus. */
const SNAP_AFTER_MS = 500;

interface Glide {
  el: HTMLDivElement | null;
  current: { x: number; y: number };
  target: { x: number; y: number };
}

export function SpaceCursors({ actors }: { actors: ReadonlyMap<string, SpaceActor> }) {
  const glides = useRef<Map<string, Glide>>(new Map());
  const raf = useRef(0);
  const lastFrame = useRef(0);

  const stop = () => {
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
  };

  const paint = (g: Glide) => {
    if (g.el) g.el.style.transform = `translate3d(${g.current.x}px, ${g.current.y}px, 0)`;
  };

  const tick = (now: number) => {
    raf.current = 0;
    const dt = now - lastFrame.current;
    lastFrame.current = now;
    // Frame-rate independent: the same feel at 60Hz and 120Hz, and a
    // throttled frame takes a proportionally bigger step.
    const alpha = dt > SNAP_AFTER_MS ? 1 : 1 - Math.exp(-dt / TAU_MS);

    let settled = true;
    for (const g of glides.current.values()) {
      const dx = g.target.x - g.current.x;
      const dy = g.target.y - g.current.y;
      if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) {
        if (g.current.x !== g.target.x || g.current.y !== g.target.y) {
          g.current = { ...g.target };
          paint(g);
        }
        continue;
      }
      settled = false;
      g.current = { x: g.current.x + dx * alpha, y: g.current.y + dy * alpha };
      paint(g);
    }
    if (!settled) raf.current = requestAnimationFrame(tick);
  };

  const wake = () => {
    if (raf.current) return;
    lastFrame.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  // New network positions → new targets. First sighting snaps: a cursor must
  // not fly in from wherever the map defaulted.
  useEffect(() => {
    const live = new Set<string>();
    for (const a of actors.values()) {
      if (a.cursor === null) continue;
      live.add(a.id);
      const existing = glides.current.get(a.id);
      if (existing) {
        existing.target = { x: a.cursor.x, y: a.cursor.y };
      } else {
        glides.current.set(a.id, {
          el: null,
          current: { x: a.cursor.x, y: a.cursor.y },
          target: { x: a.cursor.x, y: a.cursor.y },
        });
      }
    }
    for (const id of glides.current.keys()) {
      if (!live.has(id)) glides.current.delete(id);
    }
    if (glides.current.size > 0) wake();
    else stop();
  });

  useEffect(() => stop, []);

  const list = [...actors.values()].filter((a) => a.cursor !== null);
  if (list.length === 0) return null;

  return (
    <ViewportPortal>
      {list.map((a) => (
        <div
          key={a.id}
          ref={(el) => {
            const g = glides.current.get(a.id);
            if (g) {
              g.el = el;
              // Position before the first paint — a null transform would
              // flash the cursor at the portal origin for one frame.
              if (el) paint(g);
            }
          }}
          className="pointer-events-none absolute z-50"
        >
          <MousePointer2 size={14} style={{ color: a.colour }} fill={a.colour} />
          <span
            className={cn(
              "ml-3 -mt-0.5 block max-w-[140px] truncate rounded-full px-1.5 py-0.5",
              "text-[9px] font-medium leading-none text-white",
            )}
            style={{ backgroundColor: a.colour }}
          >
            {a.name}
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}
