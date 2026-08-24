// Floating mention picker. Anchored to a fixed coordinate (the caret of the
// `@` in the CodeMirror composer), driven by an imperative keyboard API so
// the editor never loses focus.
//
// Two views (Linear-style — search-first, no category step):
//   • No scope locked: ONE blended search across every kind, rendered as
//     per-kind sections (Files / Knowledge / Cloned Repos / …) in the order
//     the ranked results surface them. Empty query shows a zero-query
//     overview (recents + a slice of each kind) with a "Browse" category
//     tail as an escape hatch for explicit scoping + past messages.
//   • Scope locked (category pick, `~`, or an alias like `@note `): results
//     from that kind only.
//
// Keyboard contract: the parent component forwards Up/Down/Enter/Esc via
// the imperative handle so CM's focus stays put — the picker never has
// DOM focus.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BookOpen,
  Bot,
  FileText,
  Boxes,
  Folder,
  FolderGit2,
  GitBranch,
  Hash,
  MessageSquare,
  Scale,
  SquareSlash,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { shortPath } from "@/lib/paths";
import { Kbd } from "@/ui/kbd";

import {
  MENTION_CATEGORIES,
  categoryForKind,
  listMessagesInPastSession,
  listPastSessions,
  searchMentions,
  type MentionCategory,
  type MentionContext,
  type MentionData,
  type MentionKind,
  type PastSessionRef,
} from "@/features/chat/lib/mentions";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import { useRecentFilesStore, type RecentFile } from "@/features/chat/stores/recent-files-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { ensureFileIndex } from "@/features/file-picker/lib/file-picker-api";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";

// ── Public API ───────────────────────────────────────────────────────────────

export interface MentionPickerHandle {
  /** Move the active row down by 1. Wraps. */
  moveDown(): void;
  /** Move the active row up by 1. Wraps. */
  moveUp(): void;
  /** Commit the active row. Returns true if a real selection happened
   *  (mention inserted, or scope locked). False if there were no results
   *  so the parent can decide what Enter does in that case. */
  commit(): boolean;
  /** Pop one level back. Returns true if we actually went back (picker
   *  was at a sub-level), false if there's nothing above the current
   *  level (so the parent can close / delete a char). */
  goBack(): boolean;
}

export interface MentionPickerProps {
  /** When false, the popover unmounts and providers stop firing. */
  open: boolean;
  /** Query text typed after the `@` (excluding the `@` itself). */
  query: string;
  /** Caret position in viewport coords, used to anchor the popover. */
  anchor: { x: number; y: number } | null;
  /** Active project root — required for project-scoped sources. */
  projectPath: string | null;
  /** Active chat agent's skill-registry id. When set, pack-component
   *  mentions (command/agent/rule) only list ones enabled for this agent. */
  agentId?: string;
  /** A mention was picked. Parent inserts the chip. */
  onSelect: (mention: MentionData) => void;
  /** Picker closed itself (Esc, no anchor, etc). */
  onClose: () => void;
  /** Optional `${kind}:${id}` set whose entries are hidden from the
   *  results (e.g. the knowledge editor passes the currently-open note
   *  so users can't @-reference the document they're editing). */
  excludeIds?: Set<string>;
  /** Additional CSS selectors that, if any ancestor matches, should
   *  NOT trigger an outside-click dismiss. Always includes
   *  `.atlas-chat-cm-host` and `.atlas-mention-picker`; callers in
   *  other surfaces (Tiptap, future composers) add their own. */
  hostSelectors?: string[];
  /** Lock the picker to a single kind from the moment it opens —
   *  skips the "Recents + Browse categories" empty view and goes
   *  straight to filtered results. Used by the kb editor's `#`
   *  trigger to scope the picker to knowledge notes only. */
  initialScope?: MentionKind | null;
}

// ── Internal model ───────────────────────────────────────────────────────────

/** One renderable row. Either a real mention or a category header (which
 *  acts as a scope-lock button when activated), or — for the Past Messages
 *  scope only — a "session" row that drills into that session's messages. */
type Row =
  | { type: "header"; label: string }
  | { type: "category"; cat: MentionCategory }
  | { type: "mention"; mention: MentionData; recentLabel?: string }
  | { type: "session"; session: PastSessionRef };

const RECENT_LIMIT = 5;

// ── Picker component ────────────────────────────────────────────────────────

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  function MentionPicker(
    {
      open,
      query,
      anchor,
      projectPath,
      agentId,
      onSelect,
      onClose,
      excludeIds,
      hostSelectors,
      initialScope,
    },
    ref,
  ) {
    const recentFiles = useRecentFilesStore.use.items();
    // Workspace mentions are scoped to the active org (see `searchWorkspaces`).
    // Subscribe so switching orgs re-runs the search and the list reflects the
    // new org's projects even while the picker stays mounted.
    const activeOrganisationId = useOrgStore.use.activeOrganisationId();
    const [scope, setScope] = useState<MentionKind | null>(initialScope ?? null);
    /** When scope === "past_message" and no `pastSession` is locked, the
     *  picker shows a sessions list (level 1). Once `pastSession` is set,
     *  it shows messages inside that session (level 2). */
    const [pastSession, setPastSession] = useState<PastSessionRef | null>(null);
    const [pastSessions, setPastSessions] = useState<PastSessionRef[]>([]);
    const [results, setResults] = useState<MentionData[]>([]);
    const [active, setActive] = useState(0);
    /** True until the backend FileIndex finishes its initial walk for the
     *  active workspace. With multiple workspaces the first `@`/`~` in a
     *  freshly-switched project can land before its index is built — without
     *  this we'd flash a misleading "No matches" instead of a loading hint. */
    const [indexing, setIndexing] = useState(false);
    /** Bumped when the backend reports the index changed, to re-run the
     *  in-flight search once the walk completes. */
    const [indexNonce, setIndexNonce] = useState(0);

    // Reset transient state when the popover (re-)opens.
    // When `initialScope` is set, lock to that scope — the picker
    // then renders as if the user had drilled into that category.
    useEffect(() => {
      if (open) {
        setScope(initialScope ?? null);
        setPastSession(null);
        setActive(0);
      } else {
        setResults([]);
        setPastSessions([]);
      }
    }, [open, initialScope]);

    // Run providers on every (query, scope, pastSession, projectPath)
    // change. Each provider gets its own AbortSignal so stale results
    // from a prior query get dropped before they hit setState. The
    // past-message scope has its own two-level path:
    //   - no pastSession: load the session list once per scope-entry
    //   - pastSession set: search messages inside that session
    useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      const ctx: MentionContext = { projectPath, agentId };

      // No debounce — the Rust side reads everything from cached
      // state now (file index, folder list, git refs, knowledge,
      // symbols are all in `MentionCacheState` / `FileIndexState`),
      // so each invoke is sub-millisecond. Firing on every keystroke
      // keeps the picker truly live; the AbortController drops the
      // result of any in-flight invoke if a newer keystroke beat it
      // back, so stale results never paint.
      const applyExcludes = (items: MentionData[]) => {
        if (!excludeIds || excludeIds.size === 0) return items;
        return items.filter((m) => !excludeIds.has(`${m.kind}:${m.id}`));
      };
      if (scope === "past_message" && !pastSession) {
        void listPastSessions(ctx).then((sessions) => {
          if (controller.signal.aborted) return;
          const q = query.trim().toLowerCase();
          const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
          setPastSessions(filtered.slice(0, 30));
          setResults([]);
        });
      } else if (scope === "past_message" && pastSession) {
        void listMessagesInPastSession(pastSession, query, controller.signal).then((msgs) => {
          if (controller.signal.aborted) return;
          setResults(applyExcludes(msgs));
          setPastSessions([]);
        });
      } else {
        void searchMentions(query, scope, ctx).then((r) => {
          if (controller.signal.aborted) return;
          setResults(applyExcludes(r));
          setPastSessions([]);
        });
      }

      return () => controller.abort();
    }, [
      open,
      query,
      scope,
      pastSession,
      projectPath,
      agentId,
      excludeIds,
      indexNonce,
      activeOrganisationId,
    ]);

    // Reset the keyboard cursor to the top ONLY when the user changes what
    // they're looking at (query/scope/session) — NOT when results merely
    // refresh in the background (e.g. the index-build `indexNonce` bump), which
    // would otherwise snap the highlight back to the first item mid-navigation.
    useEffect(() => {
      setActive(0);
    }, [query, scope, pastSession]);

    // Detect whether the active workspace's file index is still building, for
    // the file-dependent scopes (blended / file / folder). Drives the
    // "Indexing files…" hint so the first `@` in a freshly-opened workspace
    // shows a loading state instead of "No matches". `ensureFileIndex` returns
    // null on the already-confirmed fast path (→ not indexing).
    useEffect(() => {
      if (!open || !projectPath) {
        setIndexing(false);
        return;
      }
      if (scope !== null && scope !== "file" && scope !== "folder") {
        setIndexing(false);
        return;
      }
      let cancelled = false;
      void ensureFileIndex(projectPath).then((status) => {
        if (cancelled) return;
        setIndexing(status ? !status.indexed : false);
      });
      return () => {
        cancelled = true;
      };
    }, [open, projectPath, scope]);

    // Flip the loading hint off and re-run the search the moment the backend
    // reports the walk completed (fired by `fileindex_open_project` on initial
    // walk and by the fs-watch debouncer thereafter).
    useEffect(() => {
      if (!open) return;
      let cancelled = false;
      let unlisten: (() => void) | null = null;
      void listen<{ workspaceId?: string }>("atlas:fileindex:updated", (ev) => {
        if (cancelled) return;
        // The event carries the owning workspace — a background reindex for
        // ANOTHER workspace must not clear this picker's loading hint or
        // re-fire its search.
        const ws = ev.payload?.workspaceId;
        if (ws && ws !== activeWorkspaceId()) return;
        setIndexing(false);
        setIndexNonce((n) => n + 1);
      }).then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }, [open]);

    // Re-run the search when packs change on disk (install, projection,
    // adopt, …) so a freshly installed component shows up without the user
    // reopening the picker. Mirrors the file-index refresh above.
    useEffect(() => {
      if (!open) return;
      const onChanged = () => setIndexNonce((n) => n + 1);
      window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
      return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
    }, [open]);

    // Build the renderable row list. Order:
    //   no scope + empty query → Recents (header) → files → Categories header → categories
    //   no scope + query       → blended results sorted by rank
    //   scope locked           → header showing scope → results in that scope
    const rows = useMemo<Row[]>(() => {
      const out: Row[] = [];
      if (scope === "past_message" && !pastSession) {
        out.push({ type: "header", label: "Past Messages · pick a session" });
        if (pastSessions.length === 0) {
          // No matches; header alone — the empty-state block below handles
          // copy when there's nothing else to show.
          return out;
        }
        for (const s of pastSessions) {
          out.push({ type: "session", session: s });
        }
        return out;
      }
      if (scope === "past_message" && pastSession) {
        out.push({
          type: "header",
          label: `↶ ${pastSession.title}`,
        });
        for (const m of results) {
          out.push({ type: "mention", mention: m });
        }
        return out;
      }
      if (scope) {
        // Group results under per-kind sub-headers. Homogeneous scopes collapse
        // to a single header (unchanged); the "component" scope (pack-delivered
        // commands/agents/rules) splits into Commands / Agents / Rules.
        const groupOf = (m: MentionData): { key: string; label: string } => {
          if (m.kind === "component") {
            const label =
              m.componentKind === "command"
                ? "Commands"
                : m.componentKind === "agent"
                  ? "Agents"
                  : "Rules";
            return { key: `component:${m.componentKind}`, label };
          }
          return { key: m.kind, label: categoryForKind(m.kind).label };
        };
        let lastKey: string | null = null;
        for (const m of results) {
          const g = groupOf(m);
          if (g.key !== lastKey) {
            out.push({ type: "header", label: g.label });
            lastKey = g.key;
          }
          out.push({ type: "mention", mention: m });
        }
        // Keep the scope header visible even with zero results (empty-state copy
        // renders below it).
        if (out.length === 0) {
          out.push({ type: "header", label: categoryForKind(scope).label });
        }
        return out;
      }
      // Unscoped: ONE blended ranked list across every kind, rendered as
      // per-kind sections. Section order = first appearance in the ranked
      // results, so the best-scoring kind leads (Linear-style). Bucketing
      // (rather than a header on every kind flip) keeps each kind together
      // even when scores interleave.
      const emptyQuery = !query.trim();
      // The recents mirror is a single global store reflecting the ACTIVE
      // workspace; right after a workspace switch there's an async window
      // where it still holds the previous project's files. Filter to THIS
      // picker's project so a recent from another project can never surface.
      const recents = emptyQuery
        ? recentFiles
            .filter(
              (r) =>
                !projectPath ||
                r.absPath === projectPath ||
                r.absPath.startsWith(projectPath + "/"),
            )
            .slice(0, RECENT_LIMIT)
        : [];
      const recentIds = new Set(recents.map((r) => r.absPath));
      if (recents.length > 0) {
        out.push({ type: "header", label: "Recent files" });
        for (const r of recents) {
          out.push({
            type: "mention",
            mention: recentToMention(r),
            recentLabel: dirOf(r.rel),
          });
        }
      }
      const buckets = new Map<string, MentionData[]>();
      for (const m of results) {
        // In the overview, a file already shown under Recents is noise twice.
        if (emptyQuery && m.kind === "file" && recentIds.has(m.id)) continue;
        const label = categoryForKind(m.kind).label;
        const bucket = buckets.get(label);
        if (bucket) bucket.push(m);
        else buckets.set(label, [m]);
      }
      for (const [label, items] of buckets) {
        out.push({ type: "header", label });
        for (const m of items) {
          out.push({ type: "mention", mention: m });
        }
      }
      // Escape hatch for explicit scoping (and the kinds that need a
      // drill-in flow, e.g. Past Messages). Only in the zero-query view —
      // once the user types, results ARE the interface.
      if (emptyQuery) {
        out.push({ type: "header", label: "Browse" });
        for (const cat of MENTION_CATEGORIES) {
          out.push({ type: "category", cat });
        }
      }
      return out;
    }, [scope, query, results, recentFiles, projectPath]);

    // Compute the navigable rows (skip headers). `active` is an index into
    // *navigable* rows, not the full list; the renderer maps it back.
    const navIndices = useMemo(() => {
      const idxs: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].type !== "header") idxs.push(i);
      }
      return idxs;
    }, [rows]);

    useEffect(() => {
      if (active >= navIndices.length) setActive(0);
    }, [active, navIndices.length]);

    const activeRowIdx = navIndices[active];
    const activeRow: Row | undefined = activeRowIdx === undefined ? undefined : rows[activeRowIdx];

    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useImperativeHandle(
      ref,
      (): MentionPickerHandle => ({
        moveDown: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a + 1) % navIndices.length);
        },
        moveUp: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a - 1 + navIndices.length) % navIndices.length);
        },
        commit: () => {
          if (!activeRow) return false;
          if (activeRow.type === "category") {
            setScope(activeRow.cat.kind);
            setActive(0);
            return true;
          }
          if (activeRow.type === "session") {
            setPastSession(activeRow.session);
            setActive(0);
            return true;
          }
          if (activeRow.type === "mention") {
            onSelectRef.current(activeRow.mention);
            return true;
          }
          return false;
        },
        goBack: () => {
          if (pastSession) {
            setPastSession(null);
            setActive(0);
            return true;
          }
          // When a scope was locked from the outside (initialScope),
          // there's no "above" level to drop to — let the parent close.
          if (scope && !initialScope) {
            setScope(null);
            setActive(0);
            return true;
          }
          return false;
        },
      }),
      [activeRow, navIndices.length, pastSession, scope, initialScope],
    );

    // Dismiss on click outside the picker AND outside the host editor.
    // Defaults cover the chat composer (.atlas-chat-cm-host); other
    // surfaces (Tiptap, future composers) pass their own selectors via
    // `hostSelectors` so a click inside their editable doesn't dismiss.
    const hostSelectorsRef = useRef(hostSelectors);
    hostSelectorsRef.current = hostSelectors;
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".atlas-chat-cm-host")) return;
        if (target.closest(".atlas-mention-picker")) return;
        const extras = hostSelectorsRef.current;
        if (extras) {
          for (const sel of extras) {
            if (target.closest(sel)) return;
          }
        }
        onCloseRef.current();
      };
      // Mousedown so we beat click handlers inside the editor.
      window.addEventListener("mousedown", handler);
      return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    if (!open || !anchor) return null;

    // Position: prefer below the caret so it doesn't cover lines above
    // the cursor (the common case for mid-page editors like the
    // knowledge note editor). Fall back to above when there isn't
    // enough room below — that's the chat composer's case since it
    // sits flush at the bottom of the viewport.
    //
    // Coords come from `view.coordsAtPos` which is viewport-relative,
    // so `position: fixed` lines up cleanly regardless of sidebars or
    // resizable panels in between.
    const PICKER_WIDTH = 420;
    const PICKER_MAX_HEIGHT = 360;
    const GAP = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.x, vw - PICKER_WIDTH - 8));
    // anchor.y is the caret's TOP. We need the line's height so the
    // popup sits just under the active line — we don't have it here,
    // so use a sensible default (matches the chat composer's caret).
    const LINE_HEIGHT = 20;
    const caretBottom = anchor.y + LINE_HEIGHT;
    const roomBelow = vh - caretBottom - 8;
    const placeBelow = roomBelow >= PICKER_MAX_HEIGHT;
    const positionStyle: React.CSSProperties = placeBelow
      ? { top: Math.max(8, caretBottom + GAP) }
      : { bottom: Math.max(8, vh - anchor.y + GAP) };

    return createPortal(
      <div
        className={cn(
          "atlas-mention-picker",
          "rounded-lg overflow-hidden",
          // Solid AMOLED panel. Deliberately NOT frosted: backdrop-blur (plus a
          // grain overlay) made the compositor re-blend this layer against the
          // composer beneath it, which glitched against the blinking caret and
          // shifting message layout. Opaque black has no such coupling.
          "bg-black border border-white/10",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.6)]",
          "flex flex-col",
        )}
        // Keep mouse interactions from blurring CM:
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          left,
          ...positionStyle,
          width: PICKER_WIDTH,
          maxHeight: PICKER_MAX_HEIGHT,
          zIndex: 9999,
        }}
      >
        {rows.length === 0 || (rows.length === 1 && rows[0].type === "header") ? (
          <div className="flex-1 px-3 py-6 text-center text-[11px] text-text-tertiary leading-snug">
            {indexing && (scope === null || scope === "file" || scope === "folder") ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-text-tertiary animate-pulse" />
                Indexing files…
              </span>
            ) : (
              emptyStateCopy({
                scope,
                pastSession: pastSession !== null,
                query: query.trim(),
                hasProject: projectPath !== null,
              })
            )}
          </div>
        ) : (
          <VirtualizedRows
            rows={rows}
            activeRowIdx={activeRowIdx}
            navIndices={navIndices}
            setActive={setActive}
            setScope={setScope}
            setPastSession={setPastSession}
            onSelect={onSelectRef}
          />
        )}
        <div className="border-t border-white/10 px-3 h-[34px] flex items-center justify-between shrink-0">
          <span className="flex items-center gap-1.5 text-[9px] text-text-tertiary">
            <Kbd>↑↓</Kbd>
            <span>navigate</span>
            <Kbd>↵</Kbd>
            <span>select</span>
          </span>
          <span className="flex items-center gap-1.5 text-[9px] text-text-tertiary">
            <Kbd>esc</Kbd>
            <span>close</span>
          </span>
        </div>
      </div>,
      document.body,
    );
  },
);

// ── Virtualized row list ────────────────────────────────────────────────────
//
// All row types render in a uniform 26 px slot so the virtualizer's
// estimateSize is exact and there's no jump on first measurement.
// Header rows visually have slightly different padding but still fit
// inside the slot, so we don't pay measureElement cost.

const ROW_HEIGHT = 26;
const PICKER_INNER_MAX_HEIGHT = 326; // 360 (picker max) − 34 (footer)

function VirtualizedRows({
  rows,
  activeRowIdx,
  navIndices,
  setActive,
  setScope,
  setPastSession,
  onSelect,
}: {
  rows: Row[];
  activeRowIdx: number | undefined;
  navIndices: number[];
  setActive: (n: number) => void;
  setScope: (k: MentionKind) => void;
  setPastSession: (s: PastSessionRef) => void;
  onSelect: React.MutableRefObject<(m: MentionData) => void>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Auto-scroll so the active row stays visible as the user navigates
  // with the keyboard. Without this the active highlight can scroll
  // off-screen below the viewport on a long results list.
  useLayoutEffect(() => {
    if (activeRowIdx === undefined) return;
    virtualizer.scrollToIndex(activeRowIdx, { align: "auto" });
  }, [activeRowIdx, virtualizer]);

  // O(1) rowIdx → navIdx lookup for hover. The inline handlers used to run
  // `navIndices.indexOf(i)` — a linear scan per mouseenter event.
  const navIdxByRow = useMemo(() => {
    const map = new Map<number, number>();
    navIndices.forEach((rowIdx, navIdx) => map.set(rowIdx, navIdx));
    return map;
  }, [navIndices]);

  // Hover re-targets the active row ONLY while not scrolling. During a wheel
  // flick, rows slide under a stationary cursor and fire mouseenter per
  // frame; each setActive re-rendered the whole visible window mid-scroll —
  // the same class of jank the chat virtualizer fixed by gating work on
  // "is the user scrolling".
  const handleHover = useCallback(
    (rowIdx: number) => {
      if (virtualizer.isScrolling) return;
      const navIdx = navIdxByRow.get(rowIdx);
      if (navIdx !== undefined) setActive(navIdx);
    },
    [virtualizer, navIdxByRow, setActive],
  );

  const handleActivate = useCallback(
    (row: Row) => {
      if (row.type === "category") {
        setScope(row.cat.kind);
        setActive(0);
      } else if (row.type === "session") {
        setPastSession(row.session);
        setActive(0);
      } else if (row.type === "mention") {
        onSelect.current(row.mention);
      }
    },
    [setScope, setPastSession, setActive, onSelect],
  );

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto overflow-x-hidden py-1"
      style={{ maxHeight: PICKER_INNER_MAX_HEIGHT }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {/* Key by the virtualizer's slot, not row content. Content-derived
            keys collided while async results streamed in (the same mention
            surfacing in two list revisions at different indices), which left
            stale absolutely-positioned nodes double-painted in one slot. */}
        {virtualizer.getVirtualItems().map((vRow) => (
          <PickerRow
            key={vRow.key}
            row={rows[vRow.index]}
            rowIdx={vRow.index}
            start={vRow.start}
            isActive={vRow.index === activeRowIdx}
            onHover={handleHover}
            onActivate={handleActivate}
          />
        ))}
      </div>
    </div>
  );
}

/** One row, memoized: a hover/keyboard move flips `isActive` on exactly two
 *  rows, so every other visible row skips re-rendering — that full-window
 *  re-render per mouse movement was the bulk of the picker's scroll cost. */
const PickerRow = memo(function PickerRow({
  row,
  rowIdx,
  start,
  isActive,
  onHover,
  onActivate,
}: {
  row: Row;
  rowIdx: number;
  start: number;
  isActive: boolean;
  onHover: (rowIdx: number) => void;
  onActivate: (row: Row) => void;
}) {
  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: ROW_HEIGHT,
    transform: `translateY(${start}px)`,
  };
  if (row.type === "header") {
    return (
      <div style={style} className="eyebrow px-3 pt-2 pb-1 truncate">
        {row.label}
      </div>
    );
  }
  const common = {
    style,
    onMouseEnter: () => onHover(rowIdx),
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      onActivate(row);
    },
    className: cn(
      "text-left px-3 flex items-center gap-2 text-[11.5px]",
      isActive
        ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
    ),
  };
  if (row.type === "category") {
    return (
      <button {...common}>
        <span className="opacity-75 w-4 flex items-center justify-center">
          <CategoryIcon kind={row.cat.kind} />
        </span>
        <span>{row.cat.label}</span>
      </button>
    );
  }
  if (row.type === "session") {
    return (
      <button {...common} title={row.session.filePath}>
        <span className="opacity-75 w-4 flex items-center justify-center">
          <MessageSquare size={11} />
        </span>
        <span className="truncate flex-1 min-w-0">{row.session.title}</span>
        <span className="text-[10px] text-text-tertiary shrink-0">
          {row.session.messageCount} msgs
        </span>
      </button>
    );
  }
  const m = row.mention;
  return (
    <button {...common} title={mentionTitle(m)}>
      <span className="opacity-75 w-4 flex items-center justify-center">
        {m.kind === "knowledge" && m.icon ? (
          <span style={{ fontSize: 12, lineHeight: 1 }}>{m.icon}</span>
        ) : (
          mentionGlyph(m)
        )}
      </span>
      <span className="truncate min-w-0">{primaryLabel(m)}</span>
      <span className="flex-1 min-w-0 text-[10px] text-text-tertiary truncate">
        {row.recentLabel ?? secondaryLabel(m)}
      </span>
    </button>
  );
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function recentToMention(r: RecentFile): MentionData {
  return {
    kind: "file",
    id: r.absPath,
    displayName: r.rel,
    absPath: r.absPath,
  };
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

/** Per-row icon. Pack components get a glyph per their componentKind so
 *  commands/agents/rules are distinguishable at a glance; everything else
 *  falls back to its category icon. */
function mentionGlyph(m: MentionData) {
  const size = 11;
  if (m.kind === "component") {
    switch (m.componentKind) {
      case "command":
        return <SquareSlash size={size} />;
      case "agent":
        return <Bot size={size} />;
      case "rule":
        return <Scale size={size} />;
    }
  }
  return <CategoryIcon kind={m.kind} />;
}

function CategoryIcon({ kind }: { kind: MentionKind }) {
  const size = 11;
  switch (kind) {
    case "file":
      return <FileText size={size} />;
    case "folder":
      return <Folder size={size} />;
    case "symbol":
      return <Hash size={size} />;
    case "knowledge":
      return <BookOpen size={size} />;
    case "component":
      return <Zap size={size} />;
    case "repo":
      return <FolderGit2 size={size} />;
    case "workspace":
      return <Boxes size={size} />;
    case "branch":
      return <GitBranch size={size} />;
    case "past_message":
      return <MessageSquare size={size} />;
    case "past_session":
      return <MessageSquare size={size} />;
  }
}

/** Primary label shown big in the picker row — last path segment, title,
 *  symbol name, etc. Matches Zed/VS Code's "name first, parent second"
 *  layout (see screenshot reference). */
function primaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return basenameOf(m.displayName);
    default:
      return m.displayName;
  }
}

function secondaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return dirOf(m.displayName);
    case "symbol":
      return `${m.symbolKind} · ${shortPath(m.filePath)}`;
    case "knowledge":
      return m.folder ? `${m.folder} · ${m.source}` : m.source;
    case "component":
      return `${m.componentKind} · pack: ${m.pack}`;
    case "repo":
      return m.hasReadme ? "cloned · README" : "cloned";
    case "workspace":
      return m.orgName ? `${m.orgName} · ${shortPath(m.absPath)}` : shortPath(m.absPath);
    case "branch":
      return m.refKind + (m.isCurrent ? " · HEAD" : "");
    case "past_message":
      return m.sessionTitle;
    case "past_session":
      return "session transcript";
  }
}

function basenameOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

function emptyStateCopy(args: {
  scope: MentionKind | null;
  pastSession: boolean;
  query: string;
  hasProject: boolean;
}): string {
  if (!args.hasProject) return "Open a project to browse references.";
  if (args.scope === "past_message" && !args.pastSession) {
    return args.query
      ? `No saved conversations matching "${args.query}".`
      : "No saved conversations in this project yet.";
  }
  if (args.scope === "past_message" && args.pastSession) {
    return args.query
      ? `No user messages matching "${args.query}".`
      : "No user messages in this session.";
  }
  if (args.scope) {
    const label = MENTION_CATEGORIES.find((c) => c.kind === args.scope)?.label ?? args.scope;
    return args.query
      ? `No ${label.toLowerCase()} matching "${args.query}".`
      : `No ${label.toLowerCase()} indexed yet.`;
  }
  return args.query
    ? `No matches for "${args.query}".`
    : "Type to search files, folders, notes, repos, branches…";
}

function mentionTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":
      return m.absPath;
    case "folder":
      return m.absPath;
    case "symbol":
      return `${m.filePath}:${m.line}`;
    case "knowledge":
      return m.filePath;
    case "component":
      return m.description || m.filePath;
    case "repo":
      return m.absPath;
    case "workspace":
      return m.absPath;
    case "branch":
      return `${m.refKind} ${m.id} (${m.sha.slice(0, 7)})`;
    case "past_message":
      return m.content;
    case "past_session":
      return m.sessionTitle;
  }
}
