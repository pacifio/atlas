import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { HintGroup, HintItem } from "@tryatlas/design";
import { useAppStore } from "@/features/app/stores/app-store";
import { terminalSessions, type FindResult } from "../lib/terminal-session";
import { useTerminalStore } from "../stores/terminal-store";

interface TerminalViewProps {
  /** This terminal owns keyboard focus (active in its pane, pane active). */
  isActive: boolean;
  /** This terminal is on screen: its tab is the active tab of its column and
   *  it is the active terminal of its pane. */
  visible: boolean;
  onFocus: () => void;
  /** The terminal tab id (layout/terminal store), used to bind pending focus
   *  requests to the correct terminal tab. */
  tabId: string;
  /** The layout terminal id (terminal-store) — the session registry's key. */
  terminalKey: string;
}

const NO_MATCHES: FindResult = { index: 0, total: 0 };

/**
 * A terminal — the VIEW over a `TerminalSession`: an xterm surface, full
 * height, plus the find bar.
 *
 * The session (PTY, xterm) lives in `terminal-session.ts` and outlives this
 * component; mounting attaches its surface, unmounting detaches it. Nothing
 * here closes a shell — the registry does that when the terminal leaves the
 * store.
 */
export const TerminalView = memo(function TerminalView({
  isActive,
  visible,
  onFocus,
  tabId,
  terminalKey,
}: TerminalViewProps) {
  const session = useMemo(
    () =>
      terminalSessions.acquire(terminalKey, {
        tabId,
        // A tab with its own directory (a session's terminal drawer) starts
        // there; a terminal tab follows the project.
        cwd:
          useTerminalStore.getState().cwds[tabId] ??
          useAppStore.getState().currentProject?.path ??
          "~",
      }),
    [terminalKey, tabId],
  );
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusPendingRef = useRef(false);
  const [search, setSearch] = useState({ open: false, query: "" });
  const [found, setFound] = useState<FindResult>(NO_MATCHES);

  const pendingFocus = useTerminalStore((s) => s.pendingFocus);
  const { clearPendingTerminalFocus } = useTerminalStore.use.actions();

  // Attach the session's surface to this view's host; detach on unmount. The
  // surface element is the session's, so a remount re-parents it and nothing
  // xterm drew is lost.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return session.attach(host);
  }, [session]);

  useEffect(() => {
    session.setVisible(visible);
    return () => session.setVisible(false);
  }, [session, visible]);

  // Keep xterm and the PTY sized to the view. The session coalesces,
  // deduplicates and defers while the box is not real (hidden tab → 0×0).
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => session.requestFit());
    ro.observe(el);
    session.requestFit();
    return () => ro.disconnect();
  }, [session]);

  // Keyboard focus follows the active terminal — unless the find bar has it.
  useEffect(() => {
    if (!isActive || !visible || search.open) return;
    session.focus();
  }, [isActive, visible, search.open, session]);

  // External focus request (⌘J / focus-terminal shortcut / a notification).
  useEffect(() => {
    if (!pendingFocus || pendingFocus.tabId !== tabId || !isActive) return;
    focusPendingRef.current = true;
  }, [isActive, pendingFocus, tabId]);

  useEffect(() => {
    if (!focusPendingRef.current || !isActive || !visible) return;
    session.focus();
    focusPendingRef.current = false;
    clearPendingTerminalFocus();
  }, [clearPendingTerminalFocus, isActive, visible, session, pendingFocus]);

  // ⌘F arrives through the keybinding layer (`terminal.find`, scoped to the
  // focused terminal panel) as a bumped `searchRequest` on the session.
  const lastSearchReq = useRef(snap.searchRequest);
  const [findFocus, setFindFocus] = useState(0);
  useEffect(() => {
    if (snap.searchRequest === lastSearchReq.current) return;
    lastSearchReq.current = snap.searchRequest;
    if (!visible) return;
    setSearch((s) => ({ ...s, open: true }));
    setFindFocus((n) => n + 1);
  }, [snap.searchRequest, visible]);
  // After the bar has rendered, so the input exists to take focus.
  useEffect(() => {
    if (findFocus === 0) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [findFocus]);

  const closeSearch = useCallback(() => {
    setSearch({ open: false, query: "" });
    setFound(NO_MATCHES);
    session.clearFind();
    session.focus();
  }, [session]);

  const step = useCallback(
    (dir: 1 | -1) => setFound(session.find(search.query, dir)),
    [session, search.query],
  );

  return (
    <div className="relative h-full w-full bg-[var(--terminal-background)]" onFocus={onFocus}>
      {/* The xterm surface. Padding lives here, outside the host: the fit
          addon measures the host, and padding inside it would be counted as
          room for cells. */}
      <div className="absolute inset-0 px-2 py-1">
        <div ref={hostRef} className="relative h-full w-full" />
      </div>

      {search.open && (
        <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 shadow-md">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            value={search.query}
            onChange={(e) => {
              const query = e.target.value;
              setSearch((s) => ({ ...s, query }));
              setFound(session.find(query, -1, true));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              // A find starts at the newest output, so Enter walks UP into
              // history (the Previous button); Shift+Enter walks back down.
              else if (e.key === "Enter") step(e.shiftKey ? 1 : -1);
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
            {search.query ? `${found.index}/${found.total}` : ""}
          </span>
          <HintGroup>
            <HintItem label="Previous match">
              <button
                type="button"
                aria-label="Previous match"
                onClick={() => step(-1)}
                className="rounded p-0.5 text-muted-foreground hover:bg-element-hover hover:text-foreground"
              >
                <ChevronUp size={13} />
              </button>
            </HintItem>
            <HintItem label="Next match">
              <button
                type="button"
                aria-label="Next match"
                onClick={() => step(1)}
                className="rounded p-0.5 text-muted-foreground hover:bg-element-hover hover:text-foreground"
              >
                <ChevronDown size={13} />
              </button>
            </HintItem>
            <HintItem label="Close find">
              <button
                type="button"
                aria-label="Close find"
                onClick={closeSearch}
                className="rounded p-0.5 text-muted-foreground hover:bg-element-hover hover:text-foreground"
              >
                <X size={13} />
              </button>
            </HintItem>
          </HintGroup>
        </div>
      )}
    </div>
  );
});
