import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { CircleDashed, Maximize2, Plus, Rows2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { tildePath } from "@/lib/paths";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";
import { fadeMask } from "@/features/layout/components/pane-tab-strip";
import { useTerminalStore, type PaneNode } from "../stores/terminal-store";
import { terminalSessions, type TerminalSession } from "../lib/terminal-session";

/**
 * A pane's terminals as a strip of tabs across its top: solid, rounded tabs
 * as wide as their content needs — a status ring (spinning while a command
 * runs, the close button on hover), then the working directory, truncated
 * past a cap — and the strip scrolls sideways once they outgrow it.
 * The active tab takes the lifted surface, the rest a quieter solid fill.
 * What the shell is doing is in the tooltip. An edge with more tabs past it
 * fades out, as the pane header's strip does; the controls after it are round
 * icon buttons, set apart by space rather than a divider.
 *
 * Nothing in it animates — no slide, no fade, no colour transition — except
 * the running ring. Tabs
 * reorder by dragging one onto another (native drag and drop): the order
 * changes on drop, in one step.
 *
 * It replaced a 220px side list (directory, branch, command, age per row),
 * which cost a terminal surface a third of its width for a list that usually
 * held one shell.
 *
 * Panes split down only: a terminal surface is a column, and a split right
 * halves an already narrow shell.
 */
export function TerminalTabStrip({
  pane,
  tabId,
  zoomed,
  hasSplits,
}: {
  pane: PaneNode;
  tabId: string;
  zoomed?: boolean;
  hasSplits: boolean;
}) {
  const {
    addTerminalToPane,
    splitPane,
    closeTerminalInPane,
    closePane,
    setActiveTerminalInPane,
    setActivePane,
    toggleZoom,
    reorderTerminalsInPane,
  } = useTerminalStore.use.actions();
  // The tab being dragged; a drop on another tab moves it to that slot.
  const dragged = useRef<string | null>(null);

  const select = (ptyId: string) => {
    setActiveTerminalInPane(tabId, pane.id, ptyId);
    setActivePane(tabId, pane.id);
  };

  const dropOn = (target: string) => {
    const from = dragged.current;
    dragged.current = null;
    if (!from || from === target) return;
    const order = pane.terminals.filter((id) => id !== from);
    order.splice(
      order.indexOf(target) +
        (pane.terminals.indexOf(from) < pane.terminals.indexOf(target) ? 1 : 0),
      0,
      from,
    );
    reorderTerminalsInPane(tabId, pane.id, order);
  };

  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useStripEdges(stripRef);
  const mask = fadeMask(edges);

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-sidebar pl-1">
      <div
        ref={stripRef}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        role="tablist"
        aria-label="Terminals"
        // Sideways scroll for a long strip; a vertical wheel scrolls it too.
        onWheel={(e) => {
          if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        className="hide-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
      >
        {pane.terminals.map((ptyId, index) => (
          <TerminalTab
            key={ptyId}
            ptyId={ptyId}
            position={index + 1}
            active={ptyId === pane.activeTerminalId}
            closable={pane.terminals.length > 1}
            onSelect={() => select(ptyId)}
            onClose={() => closeTerminalInPane(tabId, pane.id, ptyId)}
            onDragStart={() => {
              dragged.current = ptyId;
            }}
            onDrop={() => dropOn(ptyId)}
          />
        ))}
      </div>

      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          {zoomed && (
            <span className="shrink-0 rounded bg-element-selected px-1.5 py-px text-3xs text-muted-foreground">
              zoomed
            </span>
          )}
          <HintItem label="New terminal">
            <IconButton
              icon={Plus}
              label="New terminal"
              size="sm"
              shape="round"
              onClick={() => {
                addTerminalToPane(tabId, pane.id);
                setActivePane(tabId, pane.id);
              }}
            />
          </HintItem>
          <HintItem label="Split down">
            <IconButton
              icon={Rows2}
              label="Split down"
              size="sm"
              shape="round"
              onClick={() => splitPane(tabId, pane.id, "vertical")}
            />
          </HintItem>
          {hasSplits && (
            <HintItem label={zoomed ? "Unzoom pane" : "Zoom pane"}>
              <IconButton
                icon={Maximize2}
                label={zoomed ? "Unzoom pane" : "Zoom pane"}
                size="sm"
                shape="round"
                aria-pressed={!!zoomed}
                onClick={() => toggleZoom(tabId, pane.id)}
              />
            </HintItem>
          )}
          {hasSplits && (
            <HintItem label="Close pane">
              <IconButton
                icon={X}
                label="Close pane"
                size="sm"
                shape="round"
                onClick={() => closePane(tabId, pane.id)}
              />
            </HintItem>
          )}
        </div>
      </HintGroup>
    </div>
  );
}

/** Sub-pixel slack: at a fractional UI scale the end of the scroll lands a
 *  hair short of `scrollWidth`, which would leave a fade on forever. */
const EDGE_TOLERANCE = 1;

/** Which ends of the strip have tabs scrolled past them. Re-measured on
 *  scroll and on resize of the strip or its tabs: it can start overflowing
 *  without anyone scrolling it (the pane narrows, a tab opens, a cwd grows). */
function useStripEdges(ref: RefObject<HTMLDivElement | null>) {
  const [edges, setEdges] = useState({ canLeft: false, canRight: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const canLeft = el.scrollLeft > EDGE_TOLERANCE;
      const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_TOLERANCE;
      // Same-value guard: `scroll` fires every frame of a scroll.
      setEdges((cur) =>
        cur.canLeft === canLeft && cur.canRight === canRight ? cur : { canLeft, canRight },
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const tab of el.children) ro.observe(tab);
    // New tabs change `scrollWidth` with no event of their own.
    const mo = new MutationObserver(() => {
      for (const tab of el.children) ro.observe(tab);
      measure();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return edges;
}

function TerminalTab({
  ptyId,
  position,
  active,
  closable,
  onSelect,
  onClose,
  onDragStart,
  onDrop,
}: {
  ptyId: string;
  /** 1-based, in strip order. */
  position: number;
  active: boolean;
  closable: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const session = useSession(ptyId);
  const summary = useSummary(session);

  const where = summary.cwd ? tildePath(summary.cwd) : "~";
  const status = summary.exited
    ? "Exited"
    : summary.command !== null
      ? `Running ${summary.command}`
      : session
        ? "Idle"
        : "Starting…";

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      aria-label={`Terminal ${position}, ${where}, ${status}`}
      title={`${where}\n${status}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        // The side panel's tab (`pane-tab.tsx`): status glyph on the left, which
        // turns into the close button on hover, then the directory.
        "group/tab flex h-6 max-w-56 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-xs outline-none select-none",
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        active
          ? "bg-element-active text-foreground"
          : "bg-element-hover text-muted-foreground hover:text-secondary-foreground",
        summary.exited && "opacity-60",
      )}
    >
      <span className="relative flex size-[12px] shrink-0 items-center justify-center">
        <span
          className={cn(
            "flex items-center justify-center",
            closable && "group-hover/tab:invisible",
          )}
        >
          {/* Dashed ring at rest; the same ring turning while a command runs.
              It turns as an even, whole-pixel box on its own layer: an odd
              size (it was 11px) puts the centre on a half pixel, which is
              re-snapped to the pixel grid every frame and reads as a wobble. */}
          <span
            className={cn(
              "flex size-[12px] items-center justify-center",
              summary.command !== null
                ? "animate-spin text-foreground will-change-transform"
                : "text-muted-foreground",
            )}
          >
            <CircleDashed size={12} aria-hidden />
          </span>
        </span>
        {closable ? (
          <button
            type="button"
            aria-label="Close terminal"
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="absolute -inset-0.5 hidden items-center justify-center rounded-sm text-muted-foreground hover:bg-element-selected hover:text-foreground group-hover/tab:flex"
          >
            <X size={12} />
          </button>
        ) : null}
      </span>
      <span className="min-w-0 truncate font-mono">{where}</span>
    </div>
  );
}

// ── Reading a session without re-rendering per output chunk ────────────────

/** The registered session for a terminal, once its view has acquired it.
 *
 *  Never `acquire` here: that would start a shell for an id the store already
 *  closed. The strip renders before the pane's terminals do, so on the first
 *  pass the session may not exist yet; the effect picks it up after commit. */
function useSession(ptyId: string): TerminalSession | undefined {
  const [session, setSession] = useState(() => terminalSessions.get(ptyId));
  useEffect(() => {
    const s = terminalSessions.get(ptyId);
    if (s !== session) setSession(s);
  });
  return session;
}

interface Summary {
  cwd: string;
  exited: boolean;
  /** The foreground command, while one runs. */
  command: string | null;
}

const EMPTY: Summary = { cwd: "", exited: false, command: null };
const noSubscribe = () => () => {};

/** The few fields a tab shows, as a value that only changes when they do —
 *  the session publishes on every parsed chunk, and a tab re-rendering at
 *  output rate behind a busy build would be all cost. */
function useSummary(session: TerminalSession | undefined): Summary {
  const cache = useRef<Summary>(EMPTY);
  const get = useCallback((): Summary => {
    if (!session) return EMPTY;
    const snap = session.getSnapshot();
    const last = snap.blocks[snap.blocks.length - 1];
    const command = last && last.running && last.command !== "" ? last.command : null;
    const c = cache.current;
    if (c.cwd === snap.cwd && c.exited === snap.exited && c.command === command) return c;
    cache.current = { cwd: snap.cwd, exited: snap.exited, command };
    return cache.current;
  }, [session]);
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, get, get);
}
