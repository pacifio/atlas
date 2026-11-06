import { useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "@/features/app/stores/app-store";
import { logEvent } from "@/features/log/lib/log";
import {
  browserEmbedBack,
  browserEmbedForward,
  browserEmbedReload,
  browserOpenWindow,
  fetchReadable,
  saveKnowledgeNote,
  type ReadableContent,
} from "../lib/browser-api";
import { normalizeUrl, toNavUrl } from "../lib/browser-url";
import type { BrowserMode } from "../lib/browser-types";
import { useLiveEmbed } from "../lib/use-live-embed";
import { BrowserAddressBar, BrowserFindBar } from "./views/browser-toolbar";
import { BrowserLiveSurface } from "./views/browser-live-surface";
import { BrowserReaderSurface } from "./views/browser-reader-surface";

interface BrowserPanelProps {
  tabId?: string;
  initialUrl?: string;
  /** The split column this browser lives in, for keyboard-focus tracking. */
  groupId?: string;
}

/**
 * The Browser tab. Live mode drives a native child webview (`useLiveEmbed`);
 * Reader mode renders a sanitized fetch of the page. This container owns the
 * state and IPC; the chrome and both bodies are props-only views.
 */
export function BrowserPanel({ tabId, initialUrl, groupId }: BrowserPanelProps) {
  // Stable embed id for the native child webview. One per browser tab.
  const embedId = useRef(tabId || `browser-${Math.random().toString(36).slice(2)}`).current;

  const [mode, setMode] = useState<BrowserMode>("live");
  const [inputUrl, setInputUrl] = useState(initialUrl || "");

  // ── Reader (sanitized fetch) state ──────────────────────────────────────
  const [page, setPage] = useState<ReadableContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadableContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentProject = useAppStore.use.currentProject();

  // ── Live (embedded native webview): state, geometry, lifecycle ──────────
  const {
    liveNav,
    createdRef,
    placeholderRef,
    overlayOpen,
    focusThisGroup,
    embedError,
    ensureLive,
  } = useLiveEmbed({ embedId, mode, initialUrl, groupId, tabId, setInputUrl });

  // ── Reader: sanitized fetch ─────────────────────────────────────────────
  const fetchPage = useCallback(
    async (url: string) => {
      url = normalizeUrl(url);
      setInputUrl(url);
      setLoading(true);
      setError(null);
      try {
        const result = await fetchReadable(url);
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
      browserEmbedBack(embedId).catch(() => {});
    } else if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setPage(prev);
      setInputUrl(prev.url);
      setHistoryIndex((i) => i - 1);
    }
  };

  const goForward = () => {
    if (mode === "live") {
      browserEmbedForward(embedId).catch(() => {});
    } else if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setPage(next);
      setInputUrl(next.url);
      setHistoryIndex((i) => i + 1);
    }
  };

  const reload = () => {
    if (mode === "live") browserEmbedReload(embedId).catch(() => {});
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
      await browserOpenWindow(url);
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
      await saveKnowledgeNote(
        currentProject.path,
        `web-${Date.now()}`,
        `# ${page.title}\n\nSource: ${page.url}\n\n${textContent.slice(0, 50000)}`,
      );
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
      <BrowserAddressBar
        mode={mode}
        inputUrl={inputUrl}
        canBack={canBack}
        canFwd={canFwd}
        isLoading={isLoading}
        canSave={!isLive && !!page && !!currentProject}
        searchOpen={searchOpen}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onInputChange={setInputUrl}
        onNavigate={navigate}
        onToggleReader={toggleReader}
        onSave={saveToKnowledge}
        onSearchOpenChange={setSearchOpen}
        onOpenWindow={openBrowserWindow}
        onOpenExternal={openExternal}
      />

      {/* Search bar (Reader only) */}
      {!isLive && searchOpen && (
        <BrowserFindBar
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSearch={handleSearch}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* ── Live mode: placeholder the native webview is positioned over ── */}
      {isLive && (
        <BrowserLiveSurface
          placeholderRef={placeholderRef}
          embedError={embedError}
          paused={createdRef.current && overlayOpen}
          pausedLabel={liveNav?.title || currentUrl()}
          showStartPage={!createdRef.current && !initialUrl}
          onSwitchToReader={toggleReader}
          onOpenWindow={openBrowserWindow}
          onOpenExternal={openExternal}
          onQuickLink={(site) => {
            setInputUrl(`https://${site}`);
            navigate(site);
          }}
        />
      )}

      {/* ── Reader mode: sanitized content ── */}
      {!isLive && (
        <BrowserReaderSurface
          contentRef={contentRef}
          page={page}
          loading={loading}
          error={error}
          canSave={!!page && !!currentProject}
          onContentClick={handleContentClick}
          onRetry={() => fetchPage(inputUrl)}
          onQuickLink={(site) => fetchPage(`https://${site}`)}
          onCopySelection={copySelection}
          onCopyLink={copyLink}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenWindow={openBrowserWindow}
          onOpenExternal={openExternal}
          onSave={saveToKnowledge}
        />
      )}
    </div>
  );
}
