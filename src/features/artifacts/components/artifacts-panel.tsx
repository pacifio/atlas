import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RailGlyph } from "@/ui/animated-icon";
import { Popover } from "@base-ui/react/popover";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Filter, RefreshCw, Search, X } from "lucide-react";

import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { BranchLine, GitDot, NumStatPill } from "@/features/projects/components/git-summary";
import { useProjectGitStore } from "@/features/projects/stores/project-git-store";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { HintGroup, HintItem } from "@/ui/hint-group";

import { onlineTeammates, useOnlineIds } from "../lib/team-presence";
import { useSessionComments } from "../lib/use-session-comments";
import { useArtifactsStore, type OpenSession } from "../stores/artifacts-store";
import type { BoardPage, BoardSession, SessionDetail as Detail } from "../types";
import {
  activeFacetCount,
  facetMatches,
  facets,
  sessionState,
  sessionTitle,
  NO_FACETS,
  type Facet,
  type FacetKey,
  type FacetSelection,
  type GroupPeriod,
} from "../lib/board";
import { boardKey } from "../lib/board-key";
import { clearDetailCache, readCachedDetail, writeCachedDetail } from "../lib/detail-cache";
import { readSessionDetail } from "../lib/read-session-detail";
import { DockButton, DOCK_ACTIVE, DOCK_TRIGGER, HeaderDock } from "./header-dock";
import { CheckpointsPicker } from "./checkpoints-picker";
import { ExportButton } from "./export-button";
import { OnlineTeammates } from "./online-teammates";
import { SessionChatPanel } from "./session-chat-panel";
import { SessionCommentsPanel } from "./session-comments-panel";
import { SessionDetail } from "./session-detail";
import { TimelineInbox } from "./timeline-inbox";
import { TimelineResults } from "./timeline-results";
import { TimelineSidebar } from "./timeline-sidebar";
import { DetailSkeleton } from "./timeline-skeleton";

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
  // By board key, not id: a Session re-sent to another Project keeps its id,
  // and a row that changed Project must still re-render.
  const sig = (s: BoardSession) => `${boardKey(s)}|${s.updatedAt}`;
  return (
    sig(a[0]) === sig(b[0]) &&
    sig(a[a.length - 1]) === sig(b[b.length - 1]) &&
    a.every((s, i) => sig(s) === sig(b[i]))
  );
}

/** The chat half of the split. Wide enough for a code block in an answer. */
const CHAT_WIDTH = 420;

/**
 * The comments half.
 *
 * Narrower than the chat by design rather than by symmetry: a chat answer
 * carries code blocks and diagrams, a comment carries a sentence or two. At the
 * chat's width the rows were mostly empty and the transcript paid for it.
 */
const COMMENTS_WIDTH = 294;

/**
 * The card's inset from the tab's edges, in px.
 *
 * Measured against the project rail's card rather than chosen: side by side
 * with the switcher, 6px read as a visibly wider gutter on the Timeline. The
 * divider and the header row are both positioned against this constant, so the
 * three cannot drift apart.
 */
const CARD_INSET = 4;

/** The nav's grain, in the order a day rolls up. */
const PERIODS: { value: GroupPeriod; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

/**
 * The grain control: one round-ended track, the active grain a filled pill
 * inside it.
 *
 * Not the icon dock's shape, deliberately. The dock's members are *actions* and
 * any of them can fire; these three are *states* and exactly one is true, which
 * is what the sliding pill says at a glance.
 */
function PeriodPill({
  period,
  onChange,
}: {
  period: GroupPeriod;
  onChange: (next: GroupPeriod) => void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center rounded-full border border-[var(--border)] p-0.5">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          aria-pressed={period === p.value}
          onClick={() => onChange(p.value)}
          className={cn(
            "flex h-full cursor-pointer items-center rounded-full px-2 text-xs leading-none outline-none transition-colors",
            period === p.value
              ? "bg-[var(--atlas-element-active)] font-medium text-[var(--foreground)]"
              : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Mirrors `BOARD_LIMIT` in `capture.rs` — how many rows one board read returns. */
const BOARD_LIMIT = 500;

/**
 * Atlas Timeline — the Sessions every project in the Organisation has recorded,
 * and the timeline of any one of them.
 *
 * List and detail live in one tab rather than two, because they are one task:
 * find the Session, read the Session. They sit side by side — the session nav
 * on the left, the open Session on the right — so opening one never loses your
 * place in the list. The nav collapses while a Session is open (the header's
 * maximise), and with nothing open the right pane is an inbox: the stats strip
 * over a prompt to pick a row.
 *
 * Correctness decisions that are easy to lose in a refactor:
 *
 * * **Reads are sequenced, not cancelled.** `invoke` has no abort, so every
 *   read carries a sequence number and only the newest may write state. A slow
 *   read for Project A landing after a switch to B must not overwrite B's
 *   sessions with A's.
 * * **`detail` is tri-state.** `undefined` = a read is in flight, `null` = the
 *   store answered and the Session does not exist. The first version collapsed
 *   the two and left a permanent spinner on any null result.
 * * **Everything resets on a Project switch** — open Session included. The
 *   old Session id means nothing in the new store.
 * * **Refresh is event-driven first** (`atlas:git-changed`, which the watcher
 *   emits on every repo move), with a 15 s poll as the fallback for capture
 *   writes that produce no git event — and the poll only runs while the tab is
 *   actually visible.
 */

/** The board row a Session was opened from, if it is still on the board. */
function boardRowFor(sessions: BoardSession[], open: OpenSession): BoardSession | undefined {
  const k = openKeyOf(open);
  return sessions.find((s) => boardKey(s) === k);
}

/** The {@link boardKey} of the open Session — the same Session id can be on the
 *  board once per Project, so the id alone does not say which row is open. */
function openKeyOf(open: OpenSession): string {
  return boardKey({
    id: open.sessionId,
    projectPath: open.projectPath,
    remoteProjectId: open.remoteProjectId ?? null,
  });
}

/**
 * A Session with its summary but not yet its timeline.
 *
 * The board row already carries every field the masthead reads, so this costs
 * nothing and removes the whole round trip from the first paint. It is only
 * ever shown with `entriesPending`, which is what stops the empty `entries`
 * being read as "this Session recorded nothing".
 */
function shellDetail(row: BoardSession): Detail {
  return {
    summary: row,
    entries: [],
    counts: { prompts: 0, responses: 0, thinking: 0, toolCalls: 0, checkpoints: 0 },
    tools: [],
  };
}

export function ArtifactsPanel() {
  // Every project in the active Organisation, not just the open one: the board
  // answers "what has been happening in our code", which does not stop at the
  // folder that happens to be focused.
  const projects = useActiveOrgProjects();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  // A stable key, so the read effect does not re-fire on unrelated project
  // mutations (a rename, a pin) that leave the set of paths unchanged.
  const projectPaths = useMemo(() => projects.map((w) => w.path).sort(), [projects]);
  // Joined only for a cheap dependency comparison — never split back
  // apart. `projectPaths` is already the array every caller wants, and a
  // separator that can occur in a path would corrupt the round trip.
  const projectsKey = projectPaths.join("\n");

  const [sessions, setSessions] = useState<BoardSession[]>([]);
  /**
   * The timeline is still arriving for the Session on screen.
   *
   * Distinct from `detail === undefined` (nothing to show yet) because the
   * masthead is painted from the board row the instant it is clicked, ahead of
   * the entries. Without this the shell's empty `entries` would render
   * "Nothing was recorded in this session." — which is exactly what a Session
   * with genuinely no rows says, and the two must not look alike.
   */
  const [entriesPending, setEntriesPending] = useState(false);
  /** `undefined` while a detail read is in flight; `null` when not found. */
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  // Held in the store, not here: this panel unmounts on every tab switch, and
  // neither the open Session nor the filter may be lost to that.
  const open = useArtifactsStore.use.open();
  const projectFilter = useArtifactsStore.use.projectFilter();
  const { openSession, setProjectFilter } = useArtifactsStore.use.actions();

  // Comments on the open Session, or `null` when it is not shared — which is
  // what hides every comment affordance rather than showing empty threads. The
  // hook resolves the Organisation's roster itself, so the account no longer
  // has to be plumbed through here.
  const comments = useSessionComments(open?.remoteProjectId ?? null, open?.sessionId ?? null);
  // Who else is here, for the header's facepile. The roster is the same
  // cached one the bylines read; the online set is one subscription here.
  const directory = useOrgDirectory();
  const onlineSet = useOnlineIds();
  const teammatesOnline = useMemo(
    () => onlineTeammates(onlineSet, directory),
    [onlineSet, directory],
  );
  // Stable identity for the memo'd board rows — an inline arrow here would
  // re-render all ~500 of them on every panel render.
  const onOpenRow = useCallback(
    (sessionId: string, projectPath: string, remoteProjectId?: string | null) =>
      openSession({ sessionId, projectPath, remoteProjectId: remoteProjectId ?? null }),
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
  /** How coarsely the nav groups rows — the header's Day / Week / Month. */
  const [period, setPeriod] = useState<GroupPeriod>("day");
  /** The nav's width and whether it is shown beside an open Session. In the
   *  layout store, persisted: a sidebar you dragged narrower or tucked away
   *  should stay that way across launches, like every other pane. */
  const showSidebar = useLayoutStore((s) => s.timelinePanel.showSidebar);
  const sidebarWidth = useLayoutStore((s) => s.timelinePanel.sidebarWidth);
  const { toggleTimelineSidebar, setTimelineSidebarWidth } = useLayoutStore.use.actions();
  /** With nothing open the nav IS the view, so the collapse flag only applies
   *  once a Session is on the right. */
  const sidebarShown = !open || showSidebar;
  /** Agent / model / branch narrowing, on top of the project filter. Project
   *  stays in the store because it also narrows the *query* sent to Rust; these
   *  three only narrow what is already on screen. */
  const [selection, setSelection] = useState<FacetSelection>(NO_FACETS);
  const [error, setError] = useState<string | null>(null);
  /** Why the open Session could not be read. Scoped to its own pane — see the
   *  `readDetail` catch. */
  const [detailError, setDetailError] = useState<string | null>(null);
  /**
   * A synced Organisation's first server read has not landed.
   *
   * The board is local-first, so for a synced Organisation the first read comes
   * back with nothing and `loaded` flips true — which rendered "No sessions
   * captured yet" for the moment before the remote rows arrived. The local-only
   * case never had this, because its first read is the whole answer.
   */
  const [cloudPending, setCloudPending] = useState(false);
  /**
   * Which Organisation we have already told the user about.
   *
   * The board re-reads on every capture and git event and on a fifteen-second
   * ticker, and all of them carry the failure flag — so without this the notice
   * would reappear every few seconds for as long as the connection is down.
   * Cleared on an org switch and on a successful read, so a later failure is
   * reported again.
   */
  const cloudFailureToldFor = useRef<string | null>(null);

  const retryCloud = useCallback(() => {
    void invoke<boolean>("artifacts_cloud_refresh")
      .then((ok) => {
        if (ok) toast.success("Cloud sessions loaded.");
        // A failed retry re-arms the notice rather than raising a second one
        // on top of the first — `refresh` below will report it again.
        else cloudFailureToldFor.current = null;
      })
      .catch(() => {
        cloudFailureToldFor.current = null;
      })
      .finally(() => void refreshRef.current?.());
  }, []);

  const reportCloudFailure = useCallback(
    (failed: boolean, orgId: string | null) => {
      if (!failed) {
        cloudFailureToldFor.current = null;
        return;
      }
      if (cloudFailureToldFor.current === orgId) return;
      cloudFailureToldFor.current = orgId;
      toast.error("Couldn't load this Organization's shared sessions.", {
        id: "timeline-cloud-failed",
        description: "Showing the sessions recorded on this machine.",
        action: { label: "Retry", onClick: retryCloud },
      });
    },
    [retryCloud],
  );

  /** `refresh` is defined below and the retry needs it; a ref keeps the two
   *  from having to be declared in dependency order. */
  const refreshRef = useRef<(() => void) | null>(null);
  /** Whether the grounded chat occupies the right half of the open Session.
   *  Local, and reset when the Session changes: a chat about the Session you
   *  just left is not a chat about the one you just opened. */
  /**
   * Which side panel is open, if any.
   *
   * One slot, not two. The pane is ~420px and both panels are *about* the
   * transcript — opening them together would leave the record narrower than the
   * thing being discussed.
   */
  const [sidePanel, setSidePanel] = useState<"chat" | "comments" | null>(null);
  /**
   * The open panel's width, held through the close animation.
   *
   * Reading it from `sidePanel` directly would snap the aside to the other
   * panel's width on the frame it closes, because `null` has no width of its
   * own — the slide-out would jump before it moved.
   */
  const lastPanelWidth = useRef(CHAT_WIDTH);
  if (sidePanel) lastPanelWidth.current = sidePanel === "chat" ? CHAT_WIDTH : COMMENTS_WIDTH;
  const panelWidth = lastPanelWidth.current;

  /** True while the divider is being dragged — keeps it lit past the pointer. */
  const [resizing, setResizing] = useState(false);

  // Drag-resize: mousedown, then listen on the window until release.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      setResizing(true);
      const onMove = (ev: MouseEvent) => setTimelineSidebarWidth(startW + ev.clientX - startX);
      const onUp = () => {
        setResizing(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, setTimelineSidebarWidth],
  );

  /** Monotonic read sequence — only the newest read may write list state. */
  const listSeq = useRef(0);
  /** Same, for the detail read. */
  const detailSeq = useRef(0);

  // Switching Organisation closes whatever was open and drops the cache.
  //
  // The comment here used to *claim* the open Session was dropped. It was not,
  // and that was the bug behind the red banner over the board: a Session from
  // the previous tenant stayed open, its detail re-read against the new one,
  // and a Project the new Organisation has never heard of came back as a
  // failure. A Session belongs to the Organisation it was opened in.
  //
  // Keyed on a ref rather than firing on mount, because a Session opened from
  // outside — the git panel's history, a Checkpoint — is set *before* this
  // panel mounts, and clearing on the first run would close it again.
  const lastOrg = useRef(activeOrganisationId);
  useEffect(() => {
    if (lastOrg.current === activeOrganisationId) return;
    lastOrg.current = activeOrganisationId;
    clearDetailCache();
    openSession(null);
    setError(null);
    // Back to the loading state rather than the previous tenant's rows. The
    // refresh below repopulates; leaving them up means one Organisation's work
    // is briefly on screen under another's name.
    setSessions([]);
    setLoaded(false);
    setCloudPending(true);
    // A new tenant gets its own notice if it also fails.
    cloudFailureToldFor.current = null;
    toast.dismiss("timeline-cloud-failed");
  }, [activeOrganisationId, openSession]);

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
      const page = await invoke<BoardPage>("artifacts_board", {
        projects: projectFilter ? [projectFilter] : projectPaths,
      });
      if (seq !== listSeq.current) return; // a newer read owns the state now
      const rows = page.sessions;
      setCloudPending(page.cloudPending);
      reportCloudFailure(page.cloudFailed, activeOrganisationId);
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
  }, [projectsKey, projectFilter, reportCloudFailure, activeOrganisationId]);

  // The retry needs `refresh` and is declared above it — see `refreshRef`.
  refreshRef.current = refresh;

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
    // No poll: the two events above cover every write path (they are why a
    // fresh session appears immediately), and the visibility handler below
    // catches anything that happened while the window was hidden. The 15s
    // interval predated both and was pure redundancy by the time it died.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      void unlisten.then((stops) => stops.forEach((stop) => stop()));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // Opening a Session reads its full timeline; the list row does not carry it.
  // The read goes to the store of the project the row came from, which is not
  // necessarily the Project currently open.
  const readDetail = useCallback(
    (showLoading: boolean) => {
      if (!open) return;
      const seq = ++detailSeq.current;
      if (showLoading) setDetail(undefined);
      // Local store first, the server second — see `readSessionDetail` for
      // why the second step is not optional: a teammate's Session in a Project
      // this machine has bound carries a local `projectPath` and is not in the
      // local store.
      readSessionDetail(open)
        .then((result) => {
          if (result) writeCachedDetail(open, result);
          if (seq !== detailSeq.current) return;
          // Keep the previous object when nothing changed.
          //
          // This is the difference between a background refresh being free and
          // being the single most expensive thing the panel does. `detail` flows
          // into `visible` → `groups` → every `Row`'s `group` prop, so swapping
          // in a structurally identical object invalidates every memo in the
          // tree and re-renders every mounted row — hundreds of them, mid-scroll.
          setDetail((current) => (sameDetail(current, result) ? current : result));
          setEntriesPending(false);
          setDetailError(null);
        })
        .catch((e) => {
          if (seq === detailSeq.current) {
            // A failed read over a painted shell must not leave the masthead up
            // with an empty timeline under it — that reads as "no rows".
            setDetail(null);
            setEntriesPending(false);
            // Deliberately NOT `setError`: that banner spans the whole board,
            // and one Session failing to open says nothing about the other
            // four hundred. It goes in the pane that failed.
            setDetailError(String(e));
          }
        });
    },
    [open],
  );

  useEffect(() => {
    setSidePanel(null);
  }, [open?.sessionId]);

  useEffect(() => {
    if (!open) {
      detailSeq.current += 1;
      setDetail(undefined);
      setEntriesPending(false);
      return;
    }
    // A Session read once this browsing session paints from memory and refreshes
    // behind the content. Stepping back to the board and into the next row is
    // the normal way to use the Timeline, and re-reading SQLite for a *finished*
    // Session put a blank panel in front of that every time.
    const cached = readCachedDetail(open);
    if (cached) {
      setDetail(cached);
      setEntriesPending(false);
      readDetail(false);
      return;
    }

    // Nothing cached — but the board row this was opened from IS the summary,
    // so the masthead can paint now and the timeline can arrive after it. That
    // matters most for a Session held on the server, where the read is a paged
    // network walk rather than a local SQLite hit and the whole pane would
    // otherwise sit on "Reading the session…" for seconds.
    const row = boardRowFor(sessions, open);
    if (row) {
      setDetail(shellDetail(row));
      setEntriesPending(true);
      readDetail(false);
      return;
    }

    setEntriesPending(false);
    readDetail(true);
    // `sessions` is read for the opening frame only — re-running this effect on
    // every board refresh would re-paint the shell over a loaded timeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Search + facets. One list, shared by the nav and the stats strip — a
   *  summary that ignores the filter above it is unreadable. */
  /**
   * The rows the NAV draws: facets only, never the search.
   *
   * Scope and search are different kinds of narrowing. A facet (or the project
   * filter, which narrows the read itself) is a standing decision about which
   * sessions you are working with, so the nav honours it. A query is a question
   * you are asking right now, and the answer to it is the table on the right —
   * if the nav emptied out to match, the one list that could show you where a
   * result SITS in your history would be gone exactly when you needed it.
   */
  const scoped = useMemo(
    () => sessions.filter((s) => facetMatches(s, selection)),
    [sessions, selection],
  );

  /** The rows the RESULTS table draws: scope, then the search on top. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((s) =>
      // Title, project, agent, model and branch — the five things someone
      // would type. Message bodies are deliberately not searched: full-text
      // over every Session is a different feature with an index behind it, and
      // pretending to offer it here returns nothing for the queries it invites.
      [s.title, s.projectName, s.agent, s.model, ...s.branches]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle)),
    );
  }, [scoped, query]);

  const narrowed = query.trim().length > 0 || activeFacetCount(selection) > 0;

  const filterMenu = (
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
  );

  return (
    // The tab is chrome; the two scrollers are content sitting in it. That is
    // the whole reason for the colour step and the rounded tops — a header that
    // shares its background with the list under it needs a rule to separate
    // them, and a curve says it better than a line.
    <div className="flex h-full min-h-0 flex-col bg-[var(--card)]">
      {error && (
        <p className="shrink-0 bg-[var(--atlas-status-error-background)] px-4 py-1.5 text-xs text-[var(--atlas-status-error-foreground)]">
          {error}
        </p>
      )}

      {/* Chrome, then one card.
       *
       * The two headers share a row above it and the two panes share the card
       * below it — the same recipe as the project rail and team chat: a
       * near-black surface inset on the sides and bottom, its edge carried by a
       * hairline ring with a soft shadow behind it. One card rather than two
       * keeps the earlier rule intact for free: only the OUTER corners are
       * round, so the nav and the pane still meet at a straight seam. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The divider runs the FULL height of the tab, header included, and it
            is the resize handle. Inside the card it stopped at the header and
            read as a seam between two boxes rather than as the edge between two
            panes. Absolute, so the header row and the card need no knowledge of
            it: its x is the card's inset plus the nav's width, both of which
            are known here.
            
            30% of the way from the default border to the strong one — the
            hairline at `--border` disappeared against the card's own
            ring at this length.

            `z-40` because it has to beat the pane's own overlays, not merely
            the pane. The card below is `relative` with `z-index: auto`, so it
            opens no stacking context and its children compete with this
            element directly — at `z-20` the detail's bottom fade (also `z-20`,
            and later in the DOM) painted its opaque end straight over the
            divider's last ~128px, which read as the seam dissolving into the
            nav. The fade belongs to one pane; the divider is the card's edge
            and outranks everything inside it. */}
        {sidebarShown && (
          <div
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            className={cn(
              "absolute top-0 z-40 w-px cursor-col-resize transition-colors",
              "after:absolute after:inset-y-0 after:-left-[3px] after:-right-[3px] after:content-['']",
              resizing && "bg-[var(--primary)]",
            )}
            style={{
              bottom: CARD_INSET,
              left: CARD_INSET + sidebarWidth,
              background: resizing
                ? undefined
                : "color-mix(in srgb, var(--atlas-border-strong) 30%, var(--border))",
            }}
          />
        )}

        <div className="flex h-[32px] shrink-0 items-center" style={{ paddingInline: CARD_INSET }}>
          {sidebarShown && (
            <>
              {/* Aligned to the card's columns below: same width, and a 1px
                  spacer standing in for the divider. */}
              <div
                className="flex h-full shrink-0 items-center gap-2 px-1.5"
                style={{ width: sidebarWidth }}
              >
                <span className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">
                  Timeline
                </span>
                <OnlineTeammates members={teammatesOnline} />
                <span className="flex-1" />
                {/* Grain. It changes what the rows under it are grouped INTO,
                    which is the one control that belongs to the list itself;
                    scope and the rest live in the pane header's dock. */}
                <PeriodPill period={period} onChange={setPeriod} />
              </div>
              <div aria-hidden className="w-px shrink-0" />
            </>
          )}

          <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5">
            {open ? (
              <>
                {/* Maximise: tuck the nav away so the Session has the whole
                    tab. The same control brings it back — one button, one
                    place, whichever state you are in. */}
                <HintGroup>
                  <DockButton
                    label={showSidebar ? "Maximize session" : "Show timeline"}
                    active={!showSidebar}
                    onClick={toggleTimelineSidebar}
                  >
                    <RailGlyph open={showSidebar} size="md" />
                  </DockButton>
                </HintGroup>
                <Breadcrumb
                  sessionId={open.sessionId}
                  title={detail?.summary.title ?? null}
                  projectPath={open.projectPath}
                  remoteProjectId={open.remoteProjectId ?? null}
                  onBack={() => openSession(null)}
                />
              </>
            ) : (
              // With no Session open this half of the bar is empty, and search
              // is the thing you came to do — so it takes the space rather than
              // hiding behind the nav's floating control.
              <BoardSearch query={query} onQuery={setQuery} />
            )}

            <div className="ml-auto flex shrink-0 items-center">
              {/* One dock: act on the open Session, jump to a commit, scope
                  the board, re-read it. */}
              {/* The dock belongs to whatever is on screen. Reading a Session,
                  the only action about *it* is exporting it — a commit jumper,
                  a board filter and a board reload are three controls for the
                  list you just left, and they sat there implying otherwise. */}
              <HeaderDock>
                {open ? (
                  detail && <ExportButton detail={detail} />
                ) : (
                  <>
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
                    {filterMenu}
                    <DockButton label="Reload timeline" onClick={() => void refresh()}>
                      <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
                    </DockButton>
                  </>
                )}
              </HeaderDock>
            </div>
          </div>
        </div>

        <div
          // On a near-black panel a shadow has almost nothing to darken, so
          // the ring carries the edge and the shadow only lifts the card.
          className="relative flex min-h-0 flex-1 overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border"
          style={{
            marginInline: CARD_INSET,
            marginBottom: CARD_INSET,
          }}
        >
          {/* The nav. Mounted only when shown, and its width is set directly —
              no transition. An animated width made the drag handle feel like it
              was towing the panel: every mousemove started a 340ms ease the
              next mousemove restarted, so the edge lagged the cursor the whole
              way. Collapsing loses its slide with it, which is the trade: a
              resize that tracks the pointer matters more than an entrance. */}
          {sidebarShown && (
            <aside
              className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
              style={{ width: sidebarWidth }}
            >
              {/* The nav owns its own scroller — it is virtualized, and the
                  virtualizer needs the scrolling element to be the one it
                  measures. */}
              <TimelineSidebar
                sessions={scoped}
                // Still loading while the remote half is outstanding *and*
                // there is nothing to show. Rows already on screen keep
                // rendering through a refresh rather than flashing back to a
                // skeleton.
                // A synced Organisation waits for BOTH halves — the local rows
                // alone are a partial board, and showing them first meant the
                // list visibly rewrote itself a moment later. An Organisation
                // with no cloud half is never pending, so it still paints as
                // soon as the store answers.
                loading={!loaded || cloudPending}
                filtered={activeFacetCount(selection) > 0 || projectFilter !== null}
                openKey={open ? openKeyOf(open) : null}
                period={period}
                onOpen={onOpenRow}
              />
              {/* Say what is being left out. A nav that silently stops at the
               *  newest few hundred reads as "this is everything". */}
              {capped && (
                <p className="shrink-0 border-t border-[var(--atlas-border-subtle)] px-3 py-1.5 text-xs leading-snug text-[var(--muted-foreground)]">
                  Showing the newest {BOARD_LIMIT} sessions — filter by project for a full history.
                </p>
              )}
            </aside>
          )}

          <main className="min-w-0 flex-1 bg-[var(--background)]">
            {open ? (
              detail === undefined ? (
                <DetailSkeleton />
              ) : detail === null ? (
                <NotFound reason={detailError} onBack={() => openSession(null)} />
              ) : (
                // Two panes, animated. The chat's *width* is what transitions —
                // sliding an overlay in would leave the detail at full width
                // behind it, and the point of the split is that the record
                // stays readable beside the answer about it.
                <div className="flex h-full min-h-0">
                  <div className="min-w-0 flex-1">
                    <SessionDetail
                      detail={detail}
                      projectPath={open.projectPath}
                      comments={comments}
                      entriesPending={entriesPending}
                      // Only when there is no local copy. A synced Session of
                      // your own is on both sides, and the local blob read is
                      // faster and works offline.
                      remote={
                        !open.projectPath && open.remoteProjectId
                          ? { projectId: open.remoteProjectId, sessionId: open.sessionId }
                          : null
                      }
                      focusCommitSha={open.commitSha}
                      chatOpen={sidePanel === "chat"}
                      onToggleChat={() =>
                        setSidePanel((current) => (current === "chat" ? null : "chat"))
                      }
                      commentsOpen={sidePanel === "comments"}
                      onToggleComments={() =>
                        setSidePanel((current) => (current === "comments" ? null : "comments"))
                      }
                    />
                  </div>
                  <aside
                    className="atlas-split shrink-0 overflow-hidden border-l border-[var(--border)]"
                    style={{ width: sidePanel ? panelWidth : 0 }}
                    aria-hidden={sidePanel === null}
                  >
                    {/* Fixed inner width so the content does not reflow through
                     *  the animation — a panel that re-wraps every frame while
                     *  opening reads as a glitch, not a transition. It tracks
                     *  the *last* panel shown, so closing animates out at the
                     *  width it opened at rather than snapping first. */}
                    <div style={{ width: panelWidth }} className="h-full">
                      {sidePanel === "chat" && (
                        <SessionChatPanel
                          detail={detail}
                          projectPath={open.projectPath}
                          onClose={() => setSidePanel(null)}
                        />
                      )}
                      {sidePanel === "comments" && comments && (
                        <SessionCommentsPanel
                          detail={detail}
                          comments={comments}
                          onClose={() => setSidePanel(null)}
                        />
                      )}
                    </div>
                  </aside>
                </div>
              )
            ) : !loaded || cloudPending ? (
              // The first board read. Without this the pane falls through to
              // the "recent Sessions" inbox with nothing in it, which reads as
              // an Organisation with no work rather than one still loading.
              <DetailSkeleton />
            ) : sessions.length === 0 ? (
              <NotEnabled />
            ) : narrowed ? (
              // Narrowed, so the question changed: not "which session next" but
              // "which of these", and that is a table's job rather than a list
              // of titles.
              <TimelineResults
                sessions={visible}
                query={query}
                selection={selection}
                projectFilter={projectFilter}
                projectName={filterable.find((p) => p.path === projectFilter)?.name ?? null}
                onClearQuery={() => setQuery("")}
                onClearFacet={(key) => setSelection((prev) => ({ ...prev, [key]: null }))}
                onClearProject={() => setProjectFilter(null)}
                onOpen={onOpenRow}
              />
            ) : (
              <TimelineInbox sessions={visible} onOpen={onOpenRow} />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/**
 * The board search, in the pane header's left half.
 *
 * A rounded field rather than the bare input the nav header carried: with a
 * Session open this same space holds the breadcrumb, and a control that only
 * sometimes exists needs an edge of its own or the bar looks broken when it
 * appears.
 */
function BoardSearch({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="flex h-7 w-[220px] min-w-0 shrink items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--background)] px-3 transition-colors focus-within:border-[var(--atlas-border-strong)]">
      <Search
        size={13}
        strokeWidth={1.6}
        className="block shrink-0 text-[var(--muted-foreground)]"
      />
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onQuery("");
        }}
        placeholder="Search sessions…"
        spellCheck={false}
        aria-label="Search sessions"
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm leading-none text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
      {query && (
        <Hint label="Clear search">
          <button
            type="button"
            onClick={() => onQuery("")}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <X size={11} />
          </button>
        </Hint>
      )}
    </div>
  );
}

/**
 * Which Session is open — `Sessions / 611dd09`.
 *
 * Two crumbs, both live. **Sessions** is the way back to the empty pane, which
 * is the only "up" this tab has. The **id** copies itself: a Session id is
 * meaningless prose but a perfectly good address, and the reason to look at one
 * is almost always to paste it somewhere else.
 *
 * The project is not a crumb — the board spans every project in the
 * Organisation, so it is on the tooltip rather than spending a third of a 32px
 * bar saying a folder name you already know.
 */
/**
 * `Sessions / <title>` — the way Linear heads an issue with its identifier and
 * name. The title is what a reader recognises; the id is what a bug report
 * needs, so it stays one click away (copy) and in the crumb's tooltip. The
 * 7-char hash only shows while the detail is still loading and there is no
 * title to put there yet.
 */
function Breadcrumb({
  sessionId,
  title,
  projectPath,
  remoteProjectId,
  onBack,
}: {
  sessionId: string;
  title: string | null;
  projectPath: string;
  /** Set when the Session is on the server, which is what makes it linkable. */
  remoteProjectId: string | null;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const label = sessionTitle(title) ?? sessionId.slice(-7);

  // Held in a ref so an unmount mid-flash cannot fire `setCopied` on a dead
  // component, and so a second click restarts the window rather than stacking.
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (flash.current ? clearTimeout(flash.current) : undefined), []);

  return (
    <span
      title={projectPath}
      className="flex min-w-0 items-center gap-1 text-sm text-[var(--muted-foreground)]"
    >
      <button
        type="button"
        onClick={onBack}
        className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
      >
        Sessions
      </button>
      <span aria-hidden className="text-[var(--atlas-text-disabled)]">
        /
      </span>
      <button
        type="button"
        onClick={() => {
          // A shared Session copies as a link a colleague can open; a local one
          // has no address to give out, so it copies the id it always did. The
          // id is useless to anyone else, which is exactly why it stops being
          // the answer the moment there is a URL.
          void (async () => {
            const url = remoteProjectId
              ? await invoke<string | null>("artifacts_cloud_session_url", {
                  projectId: remoteProjectId,
                  sessionId,
                }).catch(() => null)
              : null;
            await copyText(url ?? sessionId);
          })();
          setCopied(true);
          if (flash.current) clearTimeout(flash.current);
          flash.current = setTimeout(() => setCopied(false), 1200);
        }}
        title={remoteProjectId ? "Copy a link to this Session" : `Copy ${sessionId}`}
        className="min-w-0 cursor-pointer truncate rounded px-1 py-0.5 text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
      >
        {copied ? "copied" : label}
      </button>
    </span>
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
 * The PROJECT group carries the git detail the project sidebar shows — a dot
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
  const summaries = useProjectGitStore.use.summaries();
  const { ensure } = useProjectGitStore.use.actions();

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
      <HintItem
        label={active ? `${active} filter${active === 1 ? "" : "s"} active` : "Filter sessions"}
      >
        <Popover.Trigger
          render={
            <button type="button" className={cn(DOCK_TRIGGER, active && DOCK_ACTIVE)}>
              <Filter size={13} />
              {/* A filter that is ON has to say so from the collapsed state — the
                values are inside the menu, and a funnel that looks identical
                either way hides an empty board behind a control nobody checks. */}
              {active > 0 && (
                <span className="absolute -right-1 -top-1 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-[var(--foreground)] px-[3px] font-mono text-3xs font-medium text-[var(--primary-foreground)]">
                  {active}
                </span>
              )}
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="flex max-h-[420px] w-[262px] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-popover shadow-xl data-closed:animate-scale-out data-open:animate-scale-in">
            {active > 0 && (
              <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
                <span className="font-mono text-2xs text-[var(--muted-foreground)]">
                  {active} active
                </span>
                <Popover.Close
                  render={
                    <button
                      type="button"
                      onClick={onClear}
                      className="cursor-pointer font-mono text-2xs uppercase tracking-[0.06em] text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors hover:no-underline hover:text-[var(--foreground)]"
                    >
                      Clear all
                    </button>
                  }
                />
              </div>
            )}

            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="h-[28px] shrink-0 border-b border-[var(--border)] bg-transparent px-3 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
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
                <p className="px-2 py-2 text-center text-xs text-[var(--muted-foreground)]">
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
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
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
        "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--atlas-element-hover)]",
        selected && "bg-[var(--atlas-element-selected)]",
      )}
    >
      {lead}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs leading-tight",
            selected
              ? "font-medium text-[var(--foreground)]"
              : "text-[var(--secondary-foreground)]",
          )}
        >
          {label}
        </span>
        {sub}
      </span>
      {selected ? (
        <Check size={11} className="shrink-0 text-[var(--foreground)]" />
      ) : (
        (trail ??
        (count !== undefined ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-[var(--muted-foreground)]">
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
 * every Project, and the only useful thing to say about it is what turning it
 * on would give you.
 */
function NotEnabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-md font-medium text-[var(--foreground)]">Nothing captured yet</h2>
      <p className="mt-1.5 max-w-[420px] text-sm leading-relaxed text-[var(--muted-foreground)]">
        Turn capture on for a project and Atlas records what you asked, what the agent did, and
        which commits came out of it — stored on this machine, with secrets scrubbed before anything
        is written.
      </p>
      {/* The control is deliberately not repeated here. Capture is per project
       *  and this board spans all of them, so the honest place to switch it on
       *  is the project pill in the titlebar, which names the one it applies to. */}
      <p className="mt-3 max-w-[420px] text-xs text-[var(--atlas-text-disabled)]">
        Click the project name in the titlebar to turn it on.
      </p>
    </div>
  );
}

/** The store answered: this Session does not exist (deleted, or another
 *  Project's id). Distinct from loading — a spinner here never resolves. */
/**
 * The open Session could not be read.
 *
 * `reason` separates "the row is gone" from "the read failed", which are not
 * the same thing and used to look identical: a Session held on the server that
 * this Organisation cannot reach was reported as deleted.
 */
function NotFound({ reason, onBack }: { reason: string | null; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-base text-[var(--secondary-foreground)]">
        {reason ?? "This session no longer exists."}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 cursor-pointer rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
      >
        Back to sessions
      </button>
    </div>
  );
}
