import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronUp,
  Filter,
  ListTree,
  RefreshCw,
} from "lucide-react";

import { AtlasIcon } from "@/components/atlas-icon";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgWorkspaces } from "@/features/workspaces/lib/org-scope";
import { BranchLine, GitDot, NumStatPill } from "@/features/workspaces/components/git-summary";
import { useWorkspaceGitStore } from "@/features/workspaces/stores/workspace-git-store";
import { cn } from "@/lib/utils";

import { useArtifactsStore } from "../stores/artifacts-store";
import type { BoardSession, SessionDetail as Detail } from "../types";
import {
  activeFacetCount,
  facetMatches,
  facets,
  sessionState,
  NO_FACETS,
  type Facet,
  type FacetKey,
  type FacetSelection,
} from "../lib/board";
import { clearDetailCache, readCachedDetail, writeCachedDetail } from "../lib/detail-cache";
import { CalendarView } from "./calendar-view";
import { Divider, Segment, SegmentButton, SEGMENT_ACTIVE, SEGMENT_TRIGGER } from "./segment";
import { CheckpointsPicker } from "./checkpoints-picker";
import { SessionChatPanel } from "./session-chat-panel";
import { SessionDetail } from "./session-detail";
import { SessionList } from "./session-list";
import { SessionStats, STATS_HEIGHT } from "./session-stats";

/**
 * Is this re-read structurally the same Session we already have?
 *
 * Deliberately a *signature*, not a deep compare: the point is to avoid touching
 * a megabyte of objects, so walking them to decide would defeat itself. The
 * three fields below move whenever a Session gains anything — a message, a tool
 * call, a Checkpoint — which is the only way its timeline can change.
 */
function sameDetail(a: Detail | null | undefined, b: Detail | null): boolean {
  if (!a || !b) return false;
  return (
    a.summary.id === b.summary.id &&
    a.summary.updatedAt === b.summary.updatedAt &&
    a.entries.length === b.entries.length
  );
}

/**
 * Same idea for the board list: cheap signature, not a deep compare. A session
 * only moves on the board when it gains activity (updatedAt) or rows
 * appear/disappear — first/last cover reordering since the read is sorted.
 */
function sameBoard(a: BoardSession[], b: BoardSession[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const sig = (s: BoardSession | undefined) => `${s?.id}|${s?.updatedAt}`;
  return (
    sig(a[0]) === sig(b[0]) &&
    sig(a[a.length - 1]) === sig(b[b.length - 1]) &&
    a.every((s, i) => s.id === b[i].id && s.updatedAt === b[i].updatedAt)
  );
}

/** The chat half of the split. Wide enough for a code block in an answer. */
const CHAT_WIDTH = 420;

/** Mirrors `BOARD_LIMIT` in `capture.rs` — how many rows one board read returns. */
const BOARD_LIMIT = 500;

/**
 * Atlas Timeline — the Sessions every project in the Organisation has recorded,
 * and the timeline of any one of them.
 *
 * List and detail live in one tab rather than two, because they are one task:
 * find the Session, read the Session.
 *
 * Correctness decisions that are easy to lose in a refactor:
 *
 * * **Reads are sequenced, not cancelled.** `invoke` has no abort, so every
 *   read carries a sequence number and only the newest may write state. A slow
 *   read for Workspace A landing after a switch to B must not overwrite B's
 *   sessions with A's.
 * * **`detail` is tri-state.** `undefined` = a read is in flight, `null` = the
 *   store answered and the Session does not exist. The first version collapsed
 *   the two and left a permanent spinner on any null result.
 * * **Everything resets on a Workspace switch** — open Session included. The
 *   old Session id means nothing in the new store.
 * * **Refresh is event-driven first** (`atlas:git-changed`, which the watcher
 *   emits on every repo move), with a 15 s poll as the fallback for capture
 *   writes that produce no git event — and the poll only runs while the tab is
 *   actually visible.
 */

export function ArtifactsPanel() {
  // Every project in the active Organisation, not just the open one: the board
  // answers "what has been happening in our code", which does not stop at the
  // folder that happens to be focused.
  const projects = useActiveOrgWorkspaces();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  // A stable key, so the read effect does not re-fire on unrelated workspace
  // mutations (a rename, a pin) that leave the set of paths unchanged.
  const projectPaths = useMemo(() => projects.map((w) => w.path).sort(), [projects]);
  // Joined only for a cheap dependency comparison — never split back
  // apart. `projectPaths` is already the array every caller wants, and a
  // separator that can occur in a path would corrupt the round trip.
  const projectsKey = projectPaths.join("\n");

  const [sessions, setSessions] = useState<BoardSession[]>([]);
  /** `undefined` while a detail read is in flight; `null` when not found. */
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  // Held in the store, not here: this panel unmounts on every tab switch, and
  // neither the open Session nor the filter may be lost to that.
  const open = useArtifactsStore.use.open();
  const projectFilter = useArtifactsStore.use.projectFilter();
  const { openSession, setProjectFilter } = useArtifactsStore.use.actions();
  // Stable identity for the memo'd board rows — an inline arrow here would
  // re-render all ~500 of them on every panel render.
  const onOpenRow = useCallback(
    (sessionId: string, projectPath: string) => openSession({ sessionId, projectPath }),
    [openSession],
  );
  /** True once the first board read has landed. */
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Board search. Lifted out of the list because the field lives in the header
   *  now. Local rather than in the store: unlike the open Session and the
   *  project filter, a search is a thing you are doing right now, and finding it
   *  still applied after a tab switch would read as an empty board. */
  const [query, setQuery] = useState("");
  /** Which axis the board is drawn on. */
  const [view, setView] = useState<"timeline" | "calendar">("timeline");
  /** The stats strip is 118px over a board you have already narrowed, so it is
   *  collapsible — and it opens by default, because a summary nobody knows is
   *  there is a summary nobody reads. */
  const [statsOpen, setStatsOpen] = useState(true);
  /** Agent / model / branch narrowing, on top of the project filter. Project
   *  stays in the store because it also narrows the *query* sent to Rust; these
   *  three only narrow what is already on screen. */
  const [selection, setSelection] = useState<FacetSelection>(NO_FACETS);
  const [error, setError] = useState<string | null>(null);
  /** Whether the grounded chat occupies the right half of the open Session.
   *  Local, and reset when the Session changes: a chat about the Session you
   *  just left is not a chat about the one you just opened. */
  const [chatOpen, setChatOpen] = useState(false);

  /** Monotonic read sequence — only the newest read may write list state. */
  const listSeq = useRef(0);
  /** Same, for the detail read. */
  const detailSeq = useRef(0);

  // The read cache holds timelines from the *previous* set of projects. Nothing
  // reads it across a switch — the open Session is dropped too — but a stale
  // Workspace's entries surviving in memory is exactly the leak this subsystem
  // is careful about everywhere else.
  useEffect(() => clearDetailCache, [activeOrganisationId]);

  // A filter naming a project that is no longer open would hide everything with
  // no way back, so it is dropped rather than left dangling.
  useEffect(() => {
    if (projectFilter && !projectPaths.includes(projectFilter)) setProjectFilter(null);
  }, [projectFilter, projectPaths, setProjectFilter]);

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    setRefreshing(true);
    try {
      // Filtering narrows the *query*, not the result. The board caps how many
      // rows it returns, so filtering afterwards would show only this project's
      // share of the newest few hundred; asking for one project reads its
      // history whole.
      const rows = await invoke<BoardSession[]>("artifacts_board", {
        projects: projectFilter ? [projectFilter] : projectPaths,
      });
      if (seq !== listSeq.current) return; // a newer read owns the state now
      // Same-data bailout, the list-side sibling of `sameDetail`: the poll and
      // the capture/git events re-read even when nothing changed, and an
      // unconditional setSessions handed a fresh array identity to the memo'd
      // grouping + all ~500 rows every 15 s. Signature over the fields that
      // move when any row changes (ids + updatedAt at both ends + count).
      setSessions((current) => (sameBoard(current, rows) ? current : rows));
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (seq === listSeq.current) setError(String(e));
    } finally {
      if (seq === listSeq.current) setRefreshing(false);
    }
    // `projectsKey` stands in for `projectPaths`: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsKey, projectFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Event-driven refresh, with a visible-only poll as the fallback for
  // capture writes (turn finished, import progressed, drain sent rows) that
  // move no git ref and therefore emit no event.
  useEffect(() => {
    // Two push signals, then the poll as a floor.
    //
    // `atlas:capture-changed` is the one that matters: the capture worker emits
    // it (coalesced) whenever it writes, which is what makes a session you just
    // started appear immediately rather than up to fifteen seconds later. It
    // did not exist before, so the poll *was* the refresh — and capture writes
    // move no git ref, so `atlas:git-changed` never fired for them.
    //
    // Any project's commit can add a Checkpoint to this board, so unlike the
    // project-scoped view this no longer filters the git event by path.
    const unlisten = Promise.all([
      listen("atlas:git-changed", () => void refresh()),
      listen("atlas:capture-changed", () => void refresh()),
    ]);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      void unlisten.then((stops) => stops.forEach((stop) => stop()));
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // Opening a Session reads its full timeline; the list row does not carry it.
  // The read goes to the store of the project the row came from, which is not
  // necessarily the Workspace currently open.
  const readDetail = useCallback(
    (showLoading: boolean) => {
      if (!open) return;
      const seq = ++detailSeq.current;
      if (showLoading) setDetail(undefined);
      invoke<Detail | null>("artifacts_session", {
        projectPath: open.projectPath,
        sessionId: open.sessionId,
      })
        .then((result) => {
          if (result) writeCachedDetail(open.projectPath, open.sessionId, result);
          if (seq !== detailSeq.current) return;
          // Keep the previous object when nothing changed.
          //
          // This is the difference between a background refresh being free and
          // being the single most expensive thing the panel does. `detail` flows
          // into `visible` → `groups` → every `Row`'s `group` prop, so swapping
          // in a structurally identical object invalidates every memo in the
          // tree and re-renders every mounted row — hundreds of them, mid-scroll.
          setDetail((current) => (sameDetail(current, result) ? current : result));
        })
        .catch((e) => {
          if (seq === detailSeq.current) {
            setDetail(null);
            setError(String(e));
          }
        });
    },
    [open],
  );

  useEffect(() => {
    setChatOpen(false);
  }, [open?.sessionId]);

  useEffect(() => {
    if (!open) {
      detailSeq.current += 1;
      setDetail(undefined);
      return;
    }
    // A Session read once this browsing session paints from memory and refreshes
    // behind the content. Stepping back to the board and into the next row is
    // the normal way to use the Timeline, and re-reading SQLite for a *finished*
    // Session put a blank panel in front of that every time.
    const cached = readCachedDetail(open.projectPath, open.sessionId);
    if (cached) {
      setDetail(cached);
      readDetail(false);
      return;
    }
    readDetail(true);
  }, [open, readDetail]);

  // A live Session keeps growing while it is open — piggyback the detail
  // re-read on the same signals that refresh the list, without flashing the
  // loading state over content that is already on screen.
  //
  // Gated on the Session actually being live. `sessions` changes on every board
  // refresh — a 15 s poll plus git and capture events — and re-reading a
  // *finished* Session on each of those costs a megabyte of IPC and a full
  // deserialize to learn that nothing moved. A Session whose last update is
  // older than the live window is not going to grow.
  useEffect(() => {
    if (!open || !loaded || !detail) return;
    if (sessionState(detail.summary) !== "live") return;
    readDetail(false);
    // `sessions` is the freshest signal that a background refresh landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Every project in the Organisation, not only those with rows on screen: the
  // board is capped, so a quiet project can be missing from the current page
  // and still be the one worth narrowing to.
  const filterable = useMemo(
    () => projects.map((w) => ({ path: w.path, name: w.name })),
    [projects],
  );

  /** The cap was reached, so there is older history the board is not showing. */
  const capped = !projectFilter && sessions.length >= BOARD_LIMIT;

  // The facet menu counts against everything the board holds, not against what
  // the search has already narrowed — otherwise every option reads "0" the
  // moment you type, and the menu stops being a way to find anything.
  const facetGroups = useMemo(() => facets(sessions), [sessions]);

  /** Search + facets. One list, shared by the board, the calendar and the stats
   *  strip — a summary that ignores the filter above it is unreadable. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (!facetMatches(s, selection)) return false;
      if (!needle) return true;
      // Title, project, agent, model and branch — the five things someone
      // would type. Message bodies are deliberately not searched: full-text
      // over every Session is a different feature with an index behind it, and
      // pretending to offer it here returns nothing for the queries it invites.
      return [s.title, s.projectName, s.agent, s.model, ...s.branches]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle));
    });
  }, [sessions, query, selection]);

  const narrowed = query.trim().length > 0 || activeFacetCount(selection) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)]">
      {/* 32px and `px-3`, matching the Console dashboard header — this used to
          be 38px, which made the Timeline the one tab whose header did not line
          up with the tab strip above it. */}
      <header className="flex h-[32px] shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
        {open ? (
          <button
            type="button"
            onClick={() => openSession(null)}
            className="-ml-1.5 flex h-[22px] cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            <ChevronLeft size={13} className="text-[var(--text-tertiary)]" />
            Timeline
          </button>
        ) : null}

        {/* The breadcrumb: which project, which session. A Session id is
            meaningless prose but a perfectly good *address*, and the board spans
            every project in the Organisation — so without the project name the
            open Session does not say where it came from. */}
        {open && (
          <>
            <span aria-hidden className="h-3 w-px shrink-0 bg-[var(--border-default)]" />
            <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
              {open.projectPath.split("/").pop()}
              <span className="text-[var(--text-ghost)]"> / </span>
              sessions
              <span className="text-[var(--text-ghost)]"> / </span>
              <span className="text-[var(--text-secondary)]">{open.sessionId.slice(-7)}</span>
            </span>
          </>
        )}

        {!open && (
          // The header IS the search field. The Atlas mark sits where a search
          // glyph would, and the input carries no border, background or padding
          // of its own — so the bar reads as one surface rather than a control
          // parked inside a title bar. The title is gone with it: a placeholder
          // that says "Search sessions" already names the tab, and the tab strip
          // above says it again.
          <>
            <AtlasIcon size={14} className="shrink-0 rounded-[3px]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions, projects, models…"
              spellCheck={false}
              aria-label="Search sessions"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!open && query.trim().length > 0 && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="flex h-5 cursor-pointer items-center rounded-[3px] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              Clear
            </button>
          )}

          {!open && (
            <>
              {/* View + stats in one segment: all three change what the board
               *shows*, and grouping them says that without a label. */}
              <Segment>
                <SegmentButton
                  active={view === "timeline"}
                  label="Timeline"
                  onClick={() => setView("timeline")}
                >
                  <ListTree size={13} />
                </SegmentButton>
                <SegmentButton
                  active={view === "calendar"}
                  label="Calendar"
                  onClick={() => setView("calendar")}
                  divided
                >
                  <CalendarDays size={13} />
                </SegmentButton>
                <SegmentButton
                  active={statsOpen}
                  label={statsOpen ? "Hide stats" : "Show stats"}
                  onClick={() => setStatsOpen((v) => !v)}
                  divided
                >
                  <ChevronUp
                    size={13}
                    className={cn("transition-transform", !statsOpen && "rotate-180")}
                  />
                </SegmentButton>
              </Segment>

              <Divider />
            </>
          )}

          {/* Scope: which rows the board is drawn from. Both open a menu over
              the same set of sessions, so they share a segment. */}
          <Segment>
            {/* Jump straight to a commit, without having to remember which
             *  Session produced it first. Reads the same project set as the
             *  board, so a project filter narrows both. */}
            <CheckpointsPicker
              projects={projectFilter ? [projectFilter] : projectPaths}
              onOpen={(row) =>
                openSession({
                  sessionId: row.sessionId,
                  projectPath: row.projectPath,
                  commitSha: row.commitSha,
                })
              }
            />
            {!open && (
              <BoardFilter
                projects={filterable}
                projectFilter={projectFilter}
                onProjectFilter={setProjectFilter}
                facets={facetGroups}
                selection={selection}
                onSelect={(key, value) =>
                  setSelection((prev) => ({ ...prev, [key]: prev[key] === value ? null : value }))
                }
                onClear={() => {
                  setSelection(NO_FACETS);
                  setProjectFilter(null);
                }}
              />
            )}
          </Segment>

          <Divider />

          {/* Alone after the last divider: refresh acts on the data rather than
              on what is shown, which is a different kind of thing from
              everything to its left. */}
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Reload timeline"
            title="Reload timeline"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
          </button>
        </div>
      </header>

      {error && (
        <p className="shrink-0 bg-[var(--status-error-muted)] px-4 py-1.5 text-[11px] text-[var(--status-error)]">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        {open ? (
          detail === undefined ? (
            <Centered>Reading the session…</Centered>
          ) : detail === null ? (
            <NotFound onBack={() => openSession(null)} />
          ) : (
            // Two panes, animated. The chat's *width* is what transitions —
            // sliding an overlay in would leave the detail at full width behind
            // it, and the point of the split is that the record stays readable
            // beside the answer about it.
            <div className="flex h-full min-h-0">
              <div className="min-w-0 flex-1">
                <SessionDetail
                  detail={detail}
                  projectPath={open.projectPath}
                  focusCommitSha={open.commitSha}
                  chatOpen={chatOpen}
                  onToggleChat={() => setChatOpen((v) => !v)}
                />
              </div>
              <aside
                className="atlas-split shrink-0 overflow-hidden border-l border-[var(--border-default)]"
                style={{ width: chatOpen ? CHAT_WIDTH : 0 }}
                aria-hidden={!chatOpen}
              >
                {/* Fixed inner width so the content does not reflow through the
                 *  animation — a chat that re-wraps every frame while opening
                 *  reads as a glitch, not a transition. */}
                <div style={{ width: CHAT_WIDTH }} className="h-full">
                  {chatOpen && (
                    <SessionChatPanel
                      detail={detail}
                      projectPath={open.projectPath}
                      onClose={() => setChatOpen(false)}
                    />
                  )}
                </div>
              </aside>
            </div>
          )
        ) : loaded && sessions.length === 0 ? (
          <NotEnabled />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {/* Animated rather than mounted/unmounted: an unmount has no exit,
                so collapsing would snap shut while expanding eased open. The
                height carries the house decelerating curve and the body carries
                the overshoot — see `.atlas-rail` for why they differ. */}
            <div
              className="atlas-rail shrink-0 overflow-hidden"
              style={{ height: statsOpen && loaded ? STATS_HEIGHT : 0 }}
              aria-hidden={!statsOpen}
            >
              <div
                className={cn(
                  "atlas-rail-body",
                  statsOpen ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0",
                )}
              >
                {loaded && <SessionStats sessions={visible} />}
              </div>
            </div>
            {/* `hide-scrollbar`: the board is a continuous rail from the first
                session to the last, and a scrollbar gutter cutting down beside
                it breaks that line — the same reason every other panel in the
                app hides its bars. Scrolling itself is unaffected. */}
            {/* The calendar branch is `overflow-hidden`, NOT `flex`. As a flex
                container this box made the calendar a flex ITEM, which sizes to
                its content on the main axis — so the month grid stopped
                wherever its widest cell ended and left the rest of the panel
                black. A block parent lets the grid fill the width, and the
                calendar scrolls its own body. */}
            <div
              className={cn(
                "min-h-0 flex-1",
                view === "calendar" ? "overflow-hidden" : "hide-scrollbar overflow-y-auto",
              )}
            >
              {view === "calendar" ? (
                <CalendarView
                  sessions={visible}
                  onOpen={(sessionId, projectPath) => openSession({ sessionId, projectPath })}
                />
              ) : (
                <SessionList
                  sessions={visible}
                  loading={!loaded}
                  filtered={narrowed}
                  onOpen={onOpenRow}
                />
              )}
            </div>
            {/* Say what is being left out. A board that silently stops at the
             *  newest few hundred reads as "this is everything". */}
            {capped && (
              <p className="shrink-0 border-t border-[var(--border-subtle)] px-4 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                Showing the newest {BOARD_LIMIT} sessions — filter by project to see a
                project&apos;s full history.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Scope the board: project, agent, model, branch.
 *
 * One menu rather than four controls in the header. Each group is single-select
 * and clicking the active option clears it, which is the interaction people try
 * first and the one that needs no second control to undo.
 *
 * **Counts are against the whole board, not the filtered view.** A menu whose
 * every option reads "0" the moment you type is a menu that cannot be used to
 * find anything.
 *
 * The PROJECT group carries the git detail the workspace sidebar shows — a dot
 * for working-tree state and the current branch — because that is what tells two
 * projects called `api` and `api-v2` apart. The other groups are plain values,
 * and searching only filters projects, which is the only list long enough to
 * need it.
 */
function BoardFilter({
  projects,
  projectFilter,
  onProjectFilter,
  facets: groups,
  selection,
  onSelect,
  onClear,
}: {
  projects: { path: string; name: string }[];
  projectFilter: string | null;
  onProjectFilter: (path: string | null) => void;
  facets: Facet[];
  selection: FacetSelection;
  onSelect: (key: FacetKey, value: string | null) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const summaries = useWorkspaceGitStore.use.summaries();
  const { ensure } = useWorkspaceGitStore.use.actions();

  const active = activeFacetCount(selection) + (projectFilter ? 1 : 0);
  const q = query.trim().toLowerCase();
  const shownProjects = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  const otherGroups = groups.filter((g) => g.key !== "project");

  return (
    <Popover.Root
      onOpenChange={(o) => {
        if (!o) {
          setQuery("");
          return;
        }
        // Warm any summary the sidebar has not fetched. `ensure` is
        // first-time-only, so this is a no-op for everything already cached.
        for (const p of projects) ensure(p.path);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={active ? `${active} filters active` : "Filter sessions"}
          title={active ? `${active} filter${active === 1 ? "" : "s"} active` : "Filter sessions"}
          className={cn(
            SEGMENT_TRIGGER,
            "relative border-l border-[var(--border-default)]",
            active && SEGMENT_ACTIVE,
          )}
        >
          <Filter size={13} />
          {/* A filter that is ON has to say so from the collapsed state — the
              values are inside the menu, and a funnel that looks identical
              either way hides an empty board behind a control nobody checks. */}
          {active > 0 && (
            <span className="absolute -right-1 -top-1 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-[var(--text-primary)] px-[3px] font-mono text-[9px] font-medium text-[var(--text-inverse)]">
              {active}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-[var(--z-max)] flex max-h-[420px] w-[262px] origin-[var(--radix-popover-content-transform-origin)] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          {active > 0 && (
            <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-[var(--border-default)] px-3">
              <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                {active} active
              </span>
              <Popover.Close asChild>
                <button
                  type="button"
                  onClick={onClear}
                  className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:no-underline hover:text-[var(--text-primary)]"
                >
                  Clear all
                </button>
              </Popover.Close>
            </div>
          )}

          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="h-[28px] shrink-0 border-b border-[var(--border-default)] bg-transparent px-3 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
            <GroupLabel>Project</GroupLabel>
            <Option
              label="All projects"
              count={projects.length}
              selected={projectFilter === null}
              onSelect={() => onProjectFilter(null)}
            />
            {shownProjects.map((p) => (
              <Option
                key={p.path}
                label={p.name}
                title={p.path}
                selected={projectFilter === p.path}
                onSelect={() => onProjectFilter(projectFilter === p.path ? null : p.path)}
                lead={<GitDot summary={summaries[p.path]} />}
                sub={<BranchLine summary={summaries[p.path]} className="mt-0.5" />}
                trail={<NumStatPill summary={summaries[p.path]} />}
              />
            ))}
            {shownProjects.length === 0 && (
              <p className="px-2 py-2 text-center text-[11px] text-[var(--text-tertiary)]">
                No project matches “{query.trim()}”.
              </p>
            )}

            {otherGroups.map((group) => (
              <div key={group.key}>
                <GroupLabel>{group.label}</GroupLabel>
                {group.options.map((o) => (
                  <Option
                    key={`${group.key}:${o.value ?? "all"}`}
                    label={o.label}
                    count={o.count}
                    selected={selection[group.key] === o.value}
                    onSelect={() => onSelect(group.key, o.value)}
                  />
                ))}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
      {children}
    </p>
  );
}

function Option({
  label,
  title,
  count,
  selected,
  onSelect,
  lead,
  sub,
  trail,
}: {
  label: string;
  title?: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
  lead?: React.ReactNode;
  sub?: React.ReactNode;
  trail?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]",
        selected && "bg-[var(--bg-selected)]",
      )}
    >
      {lead}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[11px] leading-tight",
            selected ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
          )}
        >
          {label}
        </span>
        {sub}
      </span>
      {selected ? (
        <Check size={11} className="shrink-0 text-[var(--text-primary)]" />
      ) : (
        (trail ??
        (count !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
            {count}
          </span>
        ) : null))
      )}
    </button>
  );
}

/**
 * The first thing a new user sees.
 *
 * Not an error, and not three alarms — capture being off is the default state of
 * every Workspace, and the only useful thing to say about it is what turning it
 * on would give you.
 */
function NotEnabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-[14px] font-medium text-[var(--text-primary)]">Nothing captured yet</h2>
      <p className="mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-[var(--text-tertiary)]">
        Turn capture on for a project and Atlas records what you asked, what the agent did, and
        which commits came out of it — stored on this machine, with secrets scrubbed before anything
        is written.
      </p>
      {/* The control is deliberately not repeated here. Capture is per project
       *  and this board spans all of them, so the honest place to switch it on
       *  is the project pill in the titlebar, which names the one it applies to. */}
      <p className="mt-3 max-w-[420px] text-[11px] text-[var(--text-ghost)]">
        Click the project name in the titlebar to turn it on.
      </p>
    </div>
  );
}

/** The store answered: this Session does not exist (deleted, or another
 *  Workspace's id). Distinct from loading — a spinner here never resolves. */
function NotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-[13px] text-[var(--text-secondary)]">This session no longer exists.</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 cursor-pointer rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        Back to sessions
      </button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-[12px] text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
