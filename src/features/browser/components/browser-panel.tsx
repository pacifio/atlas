import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { logEvent } from "@/features/log/lib/log";
import { cn } from "@/lib/utils";
import { isBrowserMock } from "@/lib/env";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useBrowserOverlayStore } from "../stores/browser-overlay-store";
import {
  Globe,
  ExternalLink,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Save,
  Search,
  Copy,
  BookOpen,
  AppWindow,
  RotateCw,
  BookText,
  Zap,
} from "lucide-react";

interface ReadableContent {
  title: string;
  url: string;
  html: string;
}

// Rust-owned navigation state for the embedded webview, pushed over the
// `atlas:browser-nav` event. The native child webview is the source of truth.
interface BrowserNav {
  id: string;
  url: string;
  loading: boolean;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

type BrowserMode = "live" | "reader";

/** Window-relative rect the native child webview is positioned to. */
interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

interface BrowserPanelProps {
  tabId?: string;
  initialUrl?: string;
  /** The split column this browser lives in, for keyboard-focus tracking. */
  groupId?: string;
}

function normalizeUrl(url: string): string {
  const t = url.trim();
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return `https://${t}`;
}

/** Omnibox resolution: a URL/host stays a URL; anything else becomes a Google
 *  search. Mirrors a normal browser's address bar. */
function toNavUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  // A bare host (has a dot, no spaces) or localhost → treat as a URL.
  const looksLikeUrl = /^localhost(:\d+)?(\/.*)?$/i.test(t) || /^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t);
  if (looksLikeUrl) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export function BrowserPanel({ tabId, initialUrl, groupId }: BrowserPanelProps) {
  // Stable embed id for the native child webview. One per browser tab.
  const embedId = useRef(tabId || `browser-${Math.random().toString(36).slice(2)}`).current;

  const [mode, setMode] = useState<BrowserMode>("live");
  const [inputUrl, setInputUrl] = useState(initialUrl || "");

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

  // ── Reader (sanitized fetch) state ──────────────────────────────────────
  const [page, setPage] = useState<ReadableContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadableContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentProject = useAppStore.use.currentProject();

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
        invoke("browser_embed_set_bounds", { id: embedId, rect }).catch(() => {
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
      invoke("browser_embed_set_visible", { id: embedId, visible }).catch(() => {
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
          await invoke("browser_embed_create", { id: embedId, url, rect });
          createdRef.current = true;
          registerEmbed();
          setEmbedError(null);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              pump();
            });
          });
        } else {
          await invoke("browser_embed_navigate", { id: embedId, url });
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
    const un = listen<BrowserNav>("atlas:browser-nav", (e) => {
      if (e.payload.id !== embedId) return;
      setLiveNav(e.payload);
      // Keep the address bar in sync with real navigation (clicks, redirects).
      setInputUrl(e.payload.url);
      // In-page navigation means the user is driving THIS pane — but only steal
      // keyboard focus if this is the visible/active tab in its column.
      if (groupId && useLayoutStore.getState().activeByGroup[groupId] === (tabId ?? embedId)) {
        focusThisGroup();
      }
    });
    return () => {
      safeUnlistenPromise(un);
    };
  }, [embedId, groupId, tabId, focusThisGroup]);

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
      invoke("browser_embed_set_visible", { id: embedId, visible: false }).catch(() => {
        lastVisibleRef.current = null;
      });
    }
  }, [mode, embedId, pump]);

  // Destroy the native webview when the tab closes (panel unmounts).
  useEffect(() => {
    return () => {
      if (createdRef.current) {
        invoke("browser_embed_destroy", { id: embedId }).catch(() => {});
        unregisterEmbed();
      }
    };
  }, [embedId, unregisterEmbed]);

  // ── Reader: sanitized fetch ─────────────────────────────────────────────
  const fetchPage = useCallback(
    async (url: string) => {
      url = normalizeUrl(url);
      setInputUrl(url);
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<ReadableContent>("fetch_readable", { url });
        setPage(result);
        setInputUrl(result.url);
        setHistory((h) => [...h.slice(0, historyIndex + 1), result]);
        setHistoryIndex((i) => i + 1);
      } catch (e) {
        setError(String(e));
        setPage(null);
      }
      setLoading(false);
    },
    [historyIndex],
  );

  // ── Unified navigation (dispatches by mode) ─────────────────────────────
  const navigate = useCallback(
    (raw: string) => {
      const url = toNavUrl(raw);
      if (!url) return;
      if (mode === "live") ensureLive(url);
      else fetchPage(url);
    },
    [mode, ensureLive, fetchPage],
  );

  // An agent's UI action pointing this (already mounted) tab at a new URL —
  // `initialUrl` is only read on mount.
  useEffect(() => {
    if (!tabId) return;
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string; url?: string }>).detail;
      if (detail?.tabId === tabId && detail.url) {
        setInputUrl(detail.url);
        navigate(detail.url);
      }
    };
    window.addEventListener("atlas:browser-navigate", onNavigate);
    return () => window.removeEventListener("atlas:browser-navigate", onNavigate);
  }, [tabId, navigate]);

  const goBack = () => {
    if (mode === "live") {
      invoke("browser_embed_back", { id: embedId }).catch(() => {});
    } else if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setPage(prev);
      setInputUrl(prev.url);
      setHistoryIndex((i) => i - 1);
    }
  };

  const goForward = () => {
    if (mode === "live") {
      invoke("browser_embed_forward", { id: embedId }).catch(() => {});
    } else if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setPage(next);
      setInputUrl(next.url);
      setHistoryIndex((i) => i + 1);
    }
  };

  const reload = () => {
    if (mode === "live") invoke("browser_embed_reload", { id: embedId }).catch(() => {});
    else if (page) fetchPage(page.url);
  };

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      fetchPage(href);
    },
    [fetchPage],
  );

  const currentUrl = () => (mode === "live" ? liveNav?.url || inputUrl : page?.url || inputUrl);

  // Open the current URL in a separate native WebKit browser window.
  const openBrowserWindow = async () => {
    const url = currentUrl();
    try {
      await invoke("browser_open_window", { url });
      logEvent({
        source: "atlas",
        kind: "browser-open-window",
        summary: `Opened ${url} in a browser window`,
        status: "success",
        payload: { url },
      });
    } catch (e) {
      logEvent({
        source: "atlas",
        kind: "browser-open-window",
        summary: `Failed to open browser window: ${url}`,
        status: "failure",
        payload: { url, error: String(e) },
      });
    }
  };

  const openExternal = async () => {
    const url = currentUrl();
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      logEvent({
        source: "atlas",
        kind: "browser-open-external",
        summary: `Opened ${url} in system browser`,
        status: "success",
        payload: { url },
      });
    } catch (e) {
      window.open(url, "_blank");
      logEvent({
        source: "atlas",
        kind: "browser-open-external-fallback",
        summary: `Tauri opener failed; fell back to window.open: ${url}`,
        status: "failure",
        payload: { url, error: String(e) },
      });
    }
  };

  const saveToKnowledge = async () => {
    if (!page || !currentProject) return;
    const textContent = contentRef.current?.innerText || "";
    try {
      await invoke("save_knowledge_note", {
        projectPath: currentProject.path,
        id: `web-${Date.now()}`,
        content: `# ${page.title}\n\nSource: ${page.url}\n\n${textContent.slice(0, 50000)}`,
      });
      const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
      useKnowledgeStore.getState().actions.loadEntries(currentProject.path);
    } catch {}
  };

  const copySelection = () => {
    const sel = window.getSelection()?.toString();
    if (sel) navigator.clipboard.writeText(sel);
  };

  const copyLink = () => {
    const url = currentUrl();
    if (url) navigator.clipboard.writeText(url);
  };

  const handleSearch = () => {
    if (!searchQuery || !contentRef.current) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_TEXT);
    const query = searchQuery.toLowerCase();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.toLowerCase() || "";
      const idx = text.indexOf(query);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + searchQuery.length);
        sel.addRange(range);
        (node as HTMLElement).parentElement?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        return;
      }
    }
  };

  // Reader is a per-page action, not a persistent mode: entering reader renders
  // the CURRENT page's readable view; toggling off returns to the live webview
  // (which is still parked at its URL).
  const toggleReader = useCallback(() => {
    if (mode === "live") {
      const url = liveNav?.url || inputUrl;
      setMode("reader");
      if (url && url.trim()) fetchPage(url);
    } else {
      setMode("live");
    }
  }, [mode, liveNav, inputUrl, fetchPage]);

  // ── Derived chrome state ────────────────────────────────────────────────
  const isLive = mode === "live";
  const canBack = isLive ? !!liveNav?.canGoBack : historyIndex > 0;
  const canFwd = isLive ? !!liveNav?.canGoForward : historyIndex < history.length - 1;
  const isLoading = isLive ? !!liveNav?.loading : loading;

  return (
    <div className="h-full flex flex-col bg-background" onMouseDownCapture={focusThisGroup}>
      {/* Address bar */}
      <div className="flex items-center gap-1.5 px-2 h-[36px] shrink-0 border-b border-border bg-background">
        {/* The live webview paints over anything below this bar, so the
            address-bar tooltips open upward. */}
        <HintGroup side="top">
          <HintItem label="Back">
            <button
              onClick={goBack}
              disabled={!canBack}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer disabled:opacity-30"
            >
              <ArrowLeft size={12} />
            </button>
          </HintItem>
          <HintItem label="Forward">
            <button
              onClick={goForward}
              disabled={!canFwd}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer disabled:opacity-30"
            >
              <ArrowRight size={12} />
            </button>
          </HintItem>
          <HintItem label="Reload">
            <button
              onClick={reload}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
            >
              {isLoading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
            </button>
          </HintItem>
        </HintGroup>

        <div className="flex-1 flex items-center gap-2 h-7 rounded border border-border bg-card px-2 focus-within:ring-1 focus-within:ring-border-strong">
          <Globe size={11} className="text-muted-foreground shrink-0" />
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(inputUrl);
            }}
            className="flex-1 bg-transparent outline-none text-xs text-foreground font-mono placeholder:text-muted-foreground"
            placeholder="Search or enter URL"
          />
        </div>

        {/* Reader toggle — renders a clean view of the current page; toggle off
            returns to the live webview. */}
        <button
          onClick={toggleReader}
          className={cn(
            "flex items-center gap-1 px-1.5 h-6 rounded transition-colors cursor-pointer",
            mode === "reader"
              ? "bg-element-hover text-foreground"
              : "hover:bg-element-hover text-muted-foreground",
          )}
          title={mode === "reader" ? "Back to live page" : "Reader view of this page"}
        >
          {mode === "reader" ? <Zap size={11} /> : <BookText size={11} />}
          <span className="text-2xs">{mode === "reader" ? "Live" : "Reader"}</span>
        </button>

        <HintGroup side="top">
          {!isLive && page && currentProject && (
            <HintItem label="Save to knowledge base">
              <button
                onClick={saveToKnowledge}
                className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
              >
                <Save size={12} />
              </button>
            </HintItem>
          )}
          {!isLive && (
            <HintItem label="Find in page">
              <button
                onClick={() => setSearchOpen(!searchOpen)}
                className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
              >
                <Search size={12} />
              </button>
            </HintItem>
          )}
          <HintItem label="Open in browser window">
            <button
              onClick={openBrowserWindow}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
            >
              <AppWindow size={12} />
            </button>
          </HintItem>
          <HintItem label="Open in system browser">
            <button
              onClick={openExternal}
              className="p-1 rounded hover:bg-element-hover text-muted-foreground transition-colors cursor-pointer"
            >
              <ExternalLink size={12} />
            </button>
          </HintItem>
        </HintGroup>
      </div>

      {/* Search bar (Reader only) */}
      {!isLive && searchOpen && (
        <div className="flex items-center gap-1.5 px-2 h-[32px] shrink-0 border-b border-border bg-background">
          <Search size={11} className="text-muted-foreground shrink-0" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
              if (e.key === "Escape") setSearchOpen(false);
            }}
            className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground"
            placeholder="Find in page..."
            autoFocus
          />
        </div>
      )}

      {/* ── Live mode: placeholder the native webview is positioned over ── */}
      {isLive && (
        <div ref={placeholderRef} className="flex-1 relative bg-background">
          <NativeOnlyNotice />
          {/* Safe fallback UI when native webview containment or creation fails */}
          {embedError && (
            <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-auto bg-background z-10">
              <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
                  <Globe size={22} className="text-muted-foreground" />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-foreground">Native Embed Fallback</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    The embedded live browser could not be native-contained in this panel area. You
                    can view in Reader mode or open in a separate window:
                  </p>
                  <p className="truncate pt-1 font-mono text-2xs text-muted-foreground">
                    {embedError}
                  </p>
                </div>
                <div className="flex flex-col gap-2 pt-1 w-full max-w-[280px]">
                  <button
                    onClick={toggleReader}
                    className="flex items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 cursor-pointer"
                  >
                    <BookOpen size={14} />
                    Switch to Reader mode
                  </button>
                  <button
                    onClick={openBrowserWindow}
                    className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
                  >
                    <AppWindow size={14} />
                    Open in a new window
                  </button>
                  <button
                    onClick={openExternal}
                    className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
                  >
                    <ExternalLink size={14} />
                    Open in default browser
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* Shown when an overlay forces the native webview to hide — it sits
              UNDER the webview, so it's only visible while the webview is gone. */}
          {createdRef.current && overlayOpen && (
            <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-auto">
              <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
                  <Globe size={22} className="text-muted-foreground" />
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-foreground">Browser paused</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A menu or dialog is open on top. Keep browsing without interruption:
                  </p>
                  {(liveNav?.title || currentUrl()) && (
                    <p className="truncate pt-1 font-mono text-2xs text-secondary-foreground">
                      {liveNav?.title || currentUrl()}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2 pt-1 w-full max-w-[280px]">
                  <button
                    onClick={openBrowserWindow}
                    className="flex items-center justify-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 cursor-pointer"
                  >
                    <AppWindow size={14} />
                    Continue in a new window
                  </button>
                  <button
                    onClick={openExternal}
                    className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
                  >
                    <ExternalLink size={14} />
                    Open in default browser
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* The start page is suppressed under the browser mock: there is no
              webview for a quick link to load, and `NativeOnlyNotice` occupies
              the same box saying exactly that. */}
          {!createdRef.current && !initialUrl && !isBrowserMock && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <Globe size={32} className="text-muted-foreground mx-auto" />
                <p className="text-sm text-secondary-foreground">Enter a URL to browse</p>
                <div className="flex flex-wrap gap-2 justify-center max-w-[320px] pt-2">
                  {["google.com", "youtube.com", "github.com", "news.ycombinator.com"].map(
                    (site) => (
                      <button
                        key={site}
                        onClick={() => {
                          setInputUrl(`https://${site}`);
                          navigate(site);
                        }}
                        className="px-2.5 py-1 rounded border border-border bg-card text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors font-mono cursor-pointer"
                      >
                        {site}
                      </button>
                    ),
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Reader mode: sanitized content ── */}
      {!isLive && (
        <ContextMenu.Root>
          <ContextMenu.Trigger
            render={
              <div
                className="flex-1 overflow-auto hide-scrollbar"
                onContextMenu={(e) => e.stopPropagation()}
              >
                {loading && (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 size={20} className="animate-spin text-primary" />
                  </div>
                )}
                {error && (
                  <div className="px-6 py-8 text-center">
                    <p className="text-sm text-error">{error}</p>
                    <button
                      onClick={() => fetchPage(inputUrl)}
                      className="mt-2 text-xs text-primary underline cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!loading && !error && page && (
                  <div className="select-text">
                    <div className="px-4 py-3 border-b border-border">
                      <h1 className="text-lg font-semibold text-foreground leading-snug">
                        {page.title}
                      </h1>
                      <span className="text-2xs text-muted-foreground font-mono">{page.url}</span>
                    </div>
                    <div
                      ref={contentRef}
                      className="reader-content px-4 py-4"
                      onClick={handleContentClick}
                      dangerouslySetInnerHTML={{ __html: page.html }}
                    />
                  </div>
                )}
                {!loading && !error && !page && (
                  <div className="h-full flex items-center justify-center py-16">
                    <div className="text-center space-y-3">
                      <BookText size={32} className="text-muted-foreground mx-auto" />
                      <p className="text-sm text-secondary-foreground">
                        Reader mode — enter a URL for a clean, JS-free view
                      </p>
                      <div className="flex flex-wrap gap-2 justify-center max-w-[300px] pt-2">
                        {[
                          "arxiv.org",
                          "github.com",
                          "news.ycombinator.com",
                          "developer.mozilla.org",
                        ].map((site) => (
                          <button
                            key={site}
                            onClick={() => fetchPage(`https://${site}`)}
                            className="px-2.5 py-1 rounded border border-border bg-card text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors font-mono cursor-pointer"
                          >
                            {site}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            }
          />
          <ContextMenu.Portal>
            {/* Base UI positions the Popup through a Positioner, and the Popup
                is static inside it — the z-index has to sit on the Positioner
                or it does nothing. */}
            <ContextMenu.Positioner className="z-popover">
              <ContextMenu.Popup className="w-[180px] rounded-lg border border-border bg-card shadow-md py-1">
                <ContextMenu.Item
                  onClick={copySelection}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <Copy size={11} className="text-muted-foreground" /> Copy Selection
                </ContextMenu.Item>
                <ContextMenu.Item
                  onClick={copyLink}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <Globe size={11} className="text-muted-foreground" /> Copy Link
                </ContextMenu.Item>
                <ContextMenu.Separator className="h-px bg-border my-1" />
                <ContextMenu.Item
                  onClick={() => setSearchOpen(true)}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <Search size={11} className="text-muted-foreground" /> Find in Page
                </ContextMenu.Item>
                <ContextMenu.Item
                  onClick={openBrowserWindow}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <AppWindow size={11} className="text-muted-foreground" /> Open in Browser Window
                </ContextMenu.Item>
                <ContextMenu.Item
                  onClick={openExternal}
                  className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                >
                  <ExternalLink size={11} className="text-muted-foreground" /> Open in System
                  Browser
                </ContextMenu.Item>
                {page && currentProject && (
                  <>
                    <ContextMenu.Separator className="h-px bg-border my-1" />
                    <ContextMenu.Item
                      onClick={saveToKnowledge}
                      className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
                    >
                      <BookOpen size={11} className="text-muted-foreground" /> Save to Knowledge
                    </ContextMenu.Item>
                  </>
                )}
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      )}
    </div>
  );
}

/**
 * The Browser tab's native-only placeholder (decision 39).
 *
 * Live mode is a real child `WebviewWindow` that the macOS window server parks
 * over this div — there is no `invoke()` behind it, so `src/dev/mock-backend/`
 * cannot fake it and never will. Without this, `bun run dev` drew the full
 * chrome (tab strip, address bar, reader toggle) around an empty rectangle,
 * which reads as a start page that has finished loading. A reviewer then
 * reports "the Browser tab is blank" as a defect, or worse signs the surface
 * off having never seen it.
 *
 * So it says what it is, in the place the page would be. Renders only under
 * `bun run dev` in an ordinary browser: `isBrowserMock` is a build-time
 * constant, so the whole component is eliminated from production, and inside
 * `dev:app` the real webview covers this div anyway.
 */
function NativeOnlyNotice() {
  if (!isBrowserMock) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-[380px] flex-col items-center gap-4 text-center">
        <div className="flex size-control-lg items-center justify-center rounded-full border border-border bg-card">
          <AppWindow size={16} className="text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <p className="heading">Native-only surface</p>
          <p className="body text-muted-foreground">
            The live browser is a native webview the window server draws over this panel, not HTML.
            Nothing in the mock backend can stand in for it.
          </p>
          <p className="caption pt-1">
            Check it in <span className="code text-secondary-foreground">bun run dev:app</span>.
            Reader mode is ordinary themed HTML and does work here.
          </p>
        </div>
      </div>
    </div>
  );
}
