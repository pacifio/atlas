import { useState, useCallback, useRef, useEffect } from "react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { logEvent } from "@/features/log/lib/log";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";
import { useBrowserOverlayStore } from "../stores/browser-overlay-store";
import {
  browserEmbedCreate,
  browserEmbedDestroy,
  browserEmbedNavigate,
  browserEmbedSetBounds,
  browserEmbedSetVisible,
  listenBrowserNav,
} from "./browser-api";
import type { BrowserMode, BrowserNav, EmbedRect } from "./browser-types";
import { normalizeUrl } from "./browser-url";

/** Sub-pixel geometry churn isn't worth a native reposition. */
const RECT_EPSILON = 0.5;

function rectsMatch(a: EmbedRect, b: EmbedRect): boolean {
  return (
    Math.abs(a.x - b.x) < RECT_EPSILON &&
    Math.abs(a.y - b.y) < RECT_EPSILON &&
    Math.abs(a.width - b.width) < RECT_EPSILON &&
    Math.abs(a.height - b.height) < RECT_EPSILON
  );
}

/** Frames of stillness before the settle loop parks itself. ~200ms at 60Hz —
 *  long enough to ride out a CSS transition's easing tail. */
const SETTLE_FRAMES = 12;

/**
 * The Browser tab's Live mode: the native child webview parked over
 * `placeholderRef`, its Rust-owned navigation state, and the geometry/visibility
 * sync that keeps it there. Moved verbatim out of `BrowserPanel`; its effects
 * run in the order they did inline.
 */
export function useLiveEmbed({
  embedId,
  mode,
  initialUrl,
  groupId,
  tabId,
  setInputUrl,
}: {
  embedId: string;
  mode: BrowserMode;
  initialUrl?: string;
  groupId?: string;
  tabId?: string;
  setInputUrl: (url: string) => void;
}) {
  // ── Live (embedded native webview) state ────────────────────────────────
  const [liveNav, setLiveNav] = useState<BrowserNav | null>(null);
  const createdRef = useRef(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<BrowserMode>(mode);
  modeRef.current = mode;

  // The native child webview floats above the DOM and can't be occluded, so it
  // must hide while any DOM overlay is open (see BrowserOverlayWatcher).
  const overlayOpen = useBrowserOverlayStore.use.overlayOpen();
  const { registerEmbed, unregisterEmbed } = useBrowserOverlayStore.use.actions();
  const overlayOpenRef = useRef(overlayOpen);
  overlayOpenRef.current = overlayOpen;

  // The native webview floats above the DOM, so clicks inside the page never
  // reach the column's focus handler. Mark this browser's split column focused
  // when the user touches the React chrome, and on user-driven navigation (only
  // when this is the active tab in its column, so a background tab can't steal
  // focus). Clicks PURELY inside the remote page still can't be detected — no
  // IPC from remote webviews.
  const focusThisGroup = useCallback(() => {
    if (!groupId) return;
    const st = useLayoutStore.getState();
    if (st.focusedGroupId === groupId) return;
    st.actions.setFocusedGroup(groupId);
  }, [groupId]);

  const [embedError, setEmbedError] = useState<string | null>(null);

  /** Previous frame's rect — drives the "geometry has settled" counter only. */
  const prevRectRef = useRef<EmbedRect | null>(null);
  const stableCountRef = useRef(0);
  /** Last rect we told Rust about. Deliberately SEPARATE from `prevRectRef`:
   *  bounds are diffed against what the native webview is actually parked at,
   *  never against the previous frame. A transition moving <0.5px/frame reads
   *  as "unchanged" every single frame, so a previous-frame diff would let the
   *  placeholder drift arbitrarily far while the webview never moves.
   *  `null` = nothing sent yet, or the last send failed — either way, re-send. */
  const sentRectRef = useRef<EmbedRect | null>(null);
  /** Last visibility we told Rust about; `null` = unknown, so re-send. */
  const lastVisibleRef = useRef<boolean | null>(null);
  /** Handle for the settle loop (see `pump`), or null when parked. */
  const rafRef = useRef<number | null>(null);
  const idleFramesRef = useRef(0);

  // ── Live: geometry + lifecycle ──────────────────────────────────────────

  const currentRect = useCallback((): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null => {
    const el = placeholderRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;

    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const x1 = Math.max(0, Math.min(winW, r.left));
    const y1 = Math.max(0, Math.min(winH, r.top));
    const x2 = Math.max(0, Math.min(winW, r.right));
    const y2 = Math.max(0, Math.min(winH, r.bottom));
    const width = x2 - x1;
    const height = y2 - y1;

    if (width <= 0 || height <= 0 || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
    return { x: x1, y: y1, width, height };
  }, []);

  // Single source of truth for the native webview's visibility & bounds.
  // Returns true while geometry is still moving, so the settle loop knows it
  // can't park yet.
  const syncVisibility = useCallback((): boolean => {
    if (modeRef.current !== "live" || !createdRef.current) return false;
    const rect = currentRect();
    const prevRect = prevRectRef.current;
    const isStable = !!rect && !!prevRect && rectsMatch(rect, prevRect);

    // Drives the settle loop. Starts as "did it move since last frame", but a
    // reposition also counts: a drift slower than the epsilon reads as stable
    // every frame, and without this the loop would park mid-transition and
    // stop tracking a still-moving element.
    let changed = !isStable;

    if (rect) {
      stableCountRef.current = isStable ? stableCountRef.current + 1 : 1;
      prevRectRef.current = rect;

      // Diffed against the last SENT rect, not the previous frame — see
      // `sentRectRef`. Cached optimistically and invalidated on failure so a
      // rejected call retries on the next sync instead of stranding the
      // webview at stale bounds forever.
      const sent = sentRectRef.current;
      if (!sent || !rectsMatch(rect, sent)) {
        changed = true;
        sentRectRef.current = rect;
        browserEmbedSetBounds(embedId, rect).catch(() => {
          sentRectRef.current = null;
        });
      }
    } else {
      stableCountRef.current = 0;
      prevRectRef.current = null;
    }

    // Require stable geometry (at least 2 consecutive checks) before showing native webview
    const isGeometryStable = rect && stableCountRef.current >= 2;
    const visible = !!isGeometryStable && !overlayOpenRef.current;
    if (lastVisibleRef.current !== visible) {
      lastVisibleRef.current = visible;
      browserEmbedSetVisible(embedId, visible).catch(() => {
        // Same self-healing rationale as bounds: without this, one swallowed
        // rejection leaves the pane natively hidden while the cache claims
        // it's visible, and nothing ever retries.
        lastVisibleRef.current = null;
      });
    }

    return changed;
  }, [embedId, currentRect]);

  /**
   * Kick a short rAF burst so a CSS transition (splitter drag, panel collapse)
   * is tracked frame-by-frame, then park once the rect holds still for
   * `SETTLE_FRAMES`. The previous shape ran rAF unconditionally for the life of
   * the window — and since the browser is a persistent module that survives tab
   * switches, that was a forced layout read every frame forever, per embed.
   */
  const pump = useCallback(() => {
    idleFramesRef.current = 0;
    if (rafRef.current !== null) return; // already running; the reset above extends it
    const step = () => {
      const moving = syncVisibility();
      idleFramesRef.current = moving ? 0 : idleFramesRef.current + 1;
      if (idleFramesRef.current >= SETTLE_FRAMES) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [syncVisibility]);

  const ensureLive = useCallback(
    async (url: string) => {
      const rect = currentRect();
      if (!rect) return;
      try {
        if (!createdRef.current) {
          logEvent({
            source: "atlas",
            kind: "browser-embed",
            summary: `Creating embedded browser child webview ${embedId} for ${url}`,
            status: "success",
            payload: { id: embedId, url, rect },
          });
          await browserEmbedCreate(embedId, url, rect);
          createdRef.current = true;
          registerEmbed();
          setEmbedError(null);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              pump();
            });
          });
        } else {
          await browserEmbedNavigate(embedId, url);
          // A later successful navigation has to retire the fallback, or one
          // transient failure pins the panel to the error UI for the rest of
          // the tab's life even though the embed is working again.
          setEmbedError(null);
        }
      } catch (e) {
        const errorMsg = String(e);
        setEmbedError(errorMsg);
        logEvent({
          source: "atlas",
          kind: "browser-embed",
          summary: `Failed to load ${url} in embedded browser; activating fallback`,
          status: "failure",
          payload: { url, error: errorMsg },
        });
      }
    },
    [embedId, currentRect, registerEmbed, pump],
  );

  // Listen for Rust-owned navigation deltas for this embed.
  useEffect(() => {
    const un = listenBrowserNav((nav) => {
      if (nav.id !== embedId) return;
      setLiveNav(nav);
      // Keep the address bar in sync with real navigation (clicks, redirects).
      setInputUrl(nav.url);
      // In-page navigation means the user is driving THIS pane — but only steal
      // keyboard focus if this is the visible/active tab in its column.
      if (groupId && useLayoutStore.getState().activeByGroup[groupId] === (tabId ?? embedId)) {
        focusThisGroup();
      }
    });
    return () => {
      safeUnlistenPromise(un);
    };
    // `setInputUrl` is the panel's state setter, so listing it never re-runs
    // this.
  }, [embedId, groupId, tabId, focusThisGroup, setInputUrl]);

  // Track geometry + visibility across layout changes & transitions.
  // `mode` is a dependency because the placeholder div only exists in Live
  // mode — a Live→Reader→Live round-trip mounts a NEW node, and without the
  // re-run the observer would stay attached to the detached one and silently
  // stop reporting.
  useEffect(() => {
    if (mode !== "live") return;
    const el = placeholderRef.current;
    if (!el) return;

    const ro = new ResizeObserver(pump);
    ro.observe(el);
    window.addEventListener("resize", pump);
    window.addEventListener("fullscreenchange", pump);
    pump();

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pump);
      window.removeEventListener("fullscreenchange", pump);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [mode, pump]);

  // Hide/restore the moment a DOM overlay opens or closes.
  useEffect(() => {
    pump();
  }, [overlayOpen, pump]);

  // Create the embed once we have an initial URL and the placeholder is laid out.
  useEffect(() => {
    if (mode !== "live") return;
    if (createdRef.current || !initialUrl) return;
    const raf = requestAnimationFrame(() => ensureLive(normalizeUrl(initialUrl)));
    return () => cancelAnimationFrame(raf);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialUrl]);

  // Toggle the native overlay's visibility when switching Live⇄Reader, and
  // (re)show + reposition when returning to Live.
  useEffect(() => {
    if (!createdRef.current) return;
    if (mode === "live") {
      pump();
    } else {
      // Reader mode tears the placeholder out of the tree, so the next Live
      // pass starts from scratch: drop both caches or the re-show is skipped
      // as "already sent" and the webview never comes back.
      lastVisibleRef.current = false;
      sentRectRef.current = null;
      prevRectRef.current = null;
      stableCountRef.current = 0;
      browserEmbedSetVisible(embedId, false).catch(() => {
        lastVisibleRef.current = null;
      });
    }
  }, [mode, embedId, pump]);

  // Destroy the native webview when the tab closes (panel unmounts).
  useEffect(() => {
    return () => {
      if (createdRef.current) {
        browserEmbedDestroy(embedId).catch(() => {});
        unregisterEmbed();
      }
    };
  }, [embedId, unregisterEmbed]);

  return {
    liveNav,
    createdRef,
    placeholderRef,
    overlayOpen,
    focusThisGroup,
    embedError,
    ensureLive,
  };
}
