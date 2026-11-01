import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";

import { useSessionComments } from "../lib/use-session-comments";
import { useArtifactsStore, type OpenSession } from "../stores/artifacts-store";
import type { BoardPage, BoardSession, SessionDetail as Detail } from "../types";
import {
  activeFacetCount,
  facetMatches,
  sessionState,
  NO_FACETS,
  type FacetSelection,
} from "../lib/board";
import { boardKey, rowForCheckout } from "../lib/board-key";
import {
  clearDetailCache,
  invalidateCachedDetail,
  readCachedDetail,
  writeCachedDetail,
} from "../lib/detail-cache";
import { readSessionDetail } from "../lib/read-session-detail";
import { SessionChatPanel } from "./session-chat-panel";
import { SessionDetail } from "./session-detail";
import { BoardFilters } from "./board-filters";
import { SessionReaderHeader } from "./session-reader";
import { TimelineBoard } from "./timeline-board";
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
  /** The reader widened to the whole tab, hiding the board beside it.
   *  Persisted with the rest of the panel's layout, so a reader you widened
   *  is still wide next launch — `showSidebar` is the same two-state choice
   *  under its original name. */
  const wideByChoice = !useLayoutStore((s) => s.timelinePanel.showSidebar);
  const { toggleTimelineSidebar } = useLayoutStore.use.actions();
  /** How wide the dock is, in pixels, so it can be animated.
   *
   *  A measured number rather than a CSS width: `width: auto` has nothing to
   *  tween from, so the panel would appear at full size on the first frame —
   *  which is the "no transition at all" this is here to fix.
   *
   *  It widens on its own when a side panel opens. The chat and the comments
   *  live INSIDE the dock, so without this they take their room from the
   *  record you opened the Session to read. */
  const mainRef = useRef<HTMLElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMainWidth(el.clientWidth));
    ro.observe(el);
    setMainWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // The Organisation's roster, for the author on each row. One subscription
  // here rather than one per row: five hundred rows each resolving their own
  // author would re-render the board every time the roster revalidated.
  const directory = useOrgDirectory();
  // Stable identity for the memo'd board rows — an inline arrow here would
  // re-render all ~500 of them on every panel render.
  // Takes the row itself rather than three strings. As a positional
  // `(sessionId, projectPath, …)` the first two are both strings and both
  // plausible either way round, and swapping them opened a Session id that
  // named a folder — which reads as "Session not found".
  const onOpenRow = useCallback(
    (row: BoardSession) =>
      openSession({
        sessionId: row.id,
        projectPath: row.projectPath,
        remoteProjectId: row.remoteProjectId,
      }),
    [openSession],
  );
  // A Session opened from outside the board — a commit's "Produced by" card,
  // Atlas Agent's open action — names its checkout but not its server Project,
  // and without that the Session reads as unshared: no comments, no link. The
  // board row knows it, so take it from there once the board has it.
  useEffect(() => {
    if (!open || open.remoteProjectId !== undefined) return;
    const row = rowForCheckout(sessions, open.sessionId, open.projectPath);
    if (row) openSession({ ...open, remoteProjectId: row.remoteProjectId });
  }, [open, sessions, openSession]);
  /** True once the first board read has landed. */
  const [loaded, setLoaded] = useState(false);
  /** Board search. Lifted out of the list because the field lives in the header
   *  now. Local rather than in the store: unlike the open Session and the
   *  project filter, a search is a thing you are doing right now, and finding it
   *  still applied after a tab switch would read as an empty board. */
  const [query, setQuery] = useState("");
  /** Agent / model / branch narrowing, on top of the project filter. Project
   *  stays in the store because it also narrows the *query* sent to Rust; these
   *  three only narrow what is already on screen. */
  const [selection, setSelection] = useState<FacetSelection>(NO_FACETS);
  /** Whose Sessions to show. Empty is everyone; `null` in the list is your
   *  own rows, which carry no author id. Multi-select, because "these two"
   *  is a real question about a team's work in a way that "these two agents"
   *  is not. */
  const [people, setPeople] = useState<(string | null)[]>([]);
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
  /** Whether the grounded chat is open beside the record.
   *
   *  A boolean, not a two-panel switch: the Session's comments used to share
   *  this slot, and they are now a panel the footer's button grows into —
   *  which is both the web's shape and one fewer thing competing for the
   *  reader's width. */
  const [chatOpen, setChatOpen] = useState(false);

  /**
   * The chat takes its room from the board, never from the record.
   *
   * Three columns do not fit: at the dock's normal width the chat pushed the
   * reader down to a few words a line and squeezed the board until its own
   * rows overlapped. The board is the thing you can do without while you are
   * asking about ONE Session, so opening the chat hides it and closing the
   * chat brings it straight back — derived, not stored, so nothing has to
   * remember to put it back.
   */
  const dockWide = wideByChoice || chatOpen;
  /**
   * The open panel's width, held through the close animation.
   *
   * Reading it from `sidePanel` directly would snap the aside to the other
   * panel's width on the frame it closes, because `null` has no width of its
   * own — the slide-out would jump before it moved.
   */
  const lastPanelWidth = useRef(CHAT_WIDTH);
  if (chatOpen) lastPanelWidth.current = CHAT_WIDTH;
  const panelWidth = lastPanelWidth.current;

  const dockWidth = useMemo(() => {
    if (mainWidth === 0) return 0;
    // Wide covers the chat too — opening it hides the board rather than
    // splitting the tab three ways.
    if (dockWide) return mainWidth;
    // Never more than most of the tab: the board has to stay readable, or the
    // split has stopped being one.
    return Math.min(620, Math.round(mainWidth * 0.82));
  }, [mainWidth, dockWide]);

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
    // A server Project belongs to the Organisation it was chosen in; kept, it
    // would narrow the next tenant's board to nothing.
    const filter = useArtifactsStore.getState().projectFilter;
    if (filter && "remote" in filter) setProjectFilter(null);
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
  }, [activeOrganisationId, openSession, setProjectFilter]);

  // A filter naming a project that is no longer open would hide everything with
  // no way back, so it is dropped rather than left dangling.
  useEffect(() => {
    if (projectFilter && "local" in projectFilter && !projectPaths.includes(projectFilter.local))
      setProjectFilter(null);
  }, [projectFilter, projectPaths, setProjectFilter]);

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      // Filtering narrows the *query*, not the result. The board caps how many
      // rows it returns, so filtering afterwards would show only this project's
      // share of the newest few hundred; asking for one project reads its
      // history whole.
      const page = await invoke<BoardPage>("artifacts_board", {
        projects: projectPaths,
        // Explicit, not `[path]`: one open folder is not a filter, and a
        // server Project with no checkout has no path to send.
        filter: projectFilter,
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
    }
    // `projectsKey` stands in for `projectPaths`: same content, stable identity.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
      listen("atlas:capture-changed", (e) => {
        // A local write to one Session. Its cached timeline is now a snapshot
        // of a Session that has since moved, and the cache is served
        // SYNCHRONOUSLY on the next open — so a stale entry is a wrong panel,
        // not a slow one.
        // The recording worker names what it wrote (`CaptureChanged` in
        // capture.rs); other emitters send nothing and only mean "re-read".
        const changed = e.payload as { sessionIds?: string[]; all?: boolean } | null;
        if (changed?.all) clearDetailCache();
        else for (const id of changed?.sessionIds ?? []) invalidateCachedDetail(id);
        void refresh();
      }),
      // The cloud half of the same story: a teammate's Session grew, or a
      // resync says everything we hold may be behind.
      listen("atlas:artifacts-cloud", (e) => {
        const frame = e.payload as { kind?: string; sessionId?: string } | null;
        if (!frame) return;
        if (frame.kind === "entryUpsert" && frame.sessionId) {
          invalidateCachedDetail(frame.sessionId);
        } else if (frame.kind === "boardChanged") {
          void refresh();
        } else if (frame.kind === "resync") {
          clearDetailCache();
          void refresh();
        }
      }),
    ]);

    // Read once more as soon as the listeners are actually live.
    //
    // `listen` is a round trip: between this panel's first read and its
    // subscription being registered there is a window, and an event emitted
    // inside it reaches nobody. Rust fills the cloud half of the board in the
    // background and emits exactly once when it lands — so losing that one
    // event left every REMOTE Session off the board until something unrelated
    // refreshed it, which is why the rows appeared the moment you opened a
    // Session or touched a filter.
    //
    // Cheap, and idempotent: a board read that finds nothing new hits the
    // `sameBoard` bailout and does not even re-render.
    void unlisten.then(() => void refresh());
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

  // A different Session is a different conversation; the chat does not
  // follow you into it.
  useEffect(() => {
    setChatOpen(false);
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  /** The cap was reached, so there is older history the board is not showing. */
  const capped = !projectFilter && sessions.length >= BOARD_LIMIT;

  /** The rows the board draws before the search: the pills' scope. */
  const scoped = useMemo(() => {
    const chosen = new Set(people);
    return sessions.filter(
      (s) => facetMatches(s, selection) && (chosen.size === 0 || chosen.has(s.authorId)),
    );
  }, [sessions, selection, people]);

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

  const narrowed = query.trim().length > 0 || activeFacetCount(selection) > 0 || people.length > 0;

  const filterMenu = (
    <BoardFilters
      // Counts against everything the board holds, never against what the
      // search has already narrowed.
      sessions={sessions}
      directory={directory}
      projectFilter={projectFilter}
      onProjectFilter={setProjectFilter}
      agentFilter={selection.agent}
      onAgentFilter={(agent) => setSelection((prev) => ({ ...prev, agent }))}
      peopleFilter={people}
      onPeopleFilter={setPeople}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      {error && (
        <p className="shrink-0 bg-[var(--atlas-status-error-background)] px-4 py-1.5 text-xs text-[var(--atlas-status-error-foreground)]">
          {error}
        </p>
      )}

      {/* Flat, edge to edge. This was a rounded card inset 4px on a lighter
          frame — a panel inside the column's own. The column border is the
          edge; the board and the reader are separated by the dock's own rule.
          A rule along the top, under the window's bar, so the view starts
          where the bar ends — the team chat's (`comms-panel.tsx`). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-border bg-background">
          {/* `flex`, not just `flex-1`: the board is a column that sizes
              itself with `flex-1 min-h-0` so its list scrolls inside a bounded
              height. In a non-flex parent that chain never resolves, the
              column grows to its content, and the list cannot scroll. */}
          <main ref={mainRef} className="flex min-w-0 flex-1 bg-[var(--background)]">
            {/* The board, always. It is the index you read *from*, and
                replacing it to show one Session lost your place on every open.
                Hidden only when the reader is widened on purpose. */}
            {!(open && dockWide) &&
              (sessions.length === 0 && loaded && !cloudPending ? (
                <NotEnabled />
              ) : (
                <TimelineBoard
                  sessions={visible}
                  directory={directory}
                  openKey={open ? openKeyOf(open) : null}
                  loading={!loaded || cloudPending}
                  narrowed={narrowed}
                  query={query}
                  onQuery={setQuery}
                  onOpen={onOpenRow}
                  filters={filterMenu}
                  note={
                    capped && (
                      // Say what is being left out. A board that silently
                      // stops at the newest few hundred reads as "this is
                      // everything".
                      <p className="text-center text-2xs text-muted-foreground">
                        Showing the newest {BOARD_LIMIT} sessions — filter by project for a full
                        history.
                      </p>
                    )
                  }
                />
              ))}

            {open && (
              // The dock. A share of the tab rather than a dragged width:
              // two sizes are the whole vocabulary the web's reader has, and
              // a drag handle here would be a third way to do the same
              // thing.
              //
              // It appears at its width rather than animating to it. A
              // reader you are opening to READ should be there when you
              // look at it; a spring on 620px of panel put a third of a
              // second between the click and the first readable line.
              <aside
                style={{ width: dockWidth }}
                className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--background)]"
              >
                {/* Fixed inner width, so the reader does not re-wrap on
                      every frame of the open — a panel that reflows while it
                      animates reads as a glitch rather than a transition. */}
                <div style={{ width: dockWidth }} className="flex h-full min-h-0 flex-col">
                  <SessionReaderHeader
                    detail={detail}
                    sessionId={open.sessionId}
                    remoteProjectId={open.remoteProjectId ?? null}
                    wide={dockWide}
                    onToggleWide={toggleTimelineSidebar}
                    onClose={() => openSession(null)}
                  />
                  {/* `@container`: the reader's measure and its stat grid size
                    themselves against the dock, not the window, so the same
                    component reads correctly at 600px and at full width. */}
                  <div className="@container flex min-h-0 flex-1">
                    {detail === undefined ? (
                      <DetailSkeleton />
                    ) : detail === null ? (
                      <NotFound reason={detailError} onBack={() => openSession(null)} />
                    ) : (
                      <div className="flex h-full min-h-0 flex-1">
                        <div className="min-w-0 flex-1">
                          <SessionDetail
                            detail={detail}
                            projectPath={open.projectPath}
                            comments={comments}
                            entriesPending={entriesPending}
                            // Only when there is no local copy. A synced Session
                            // of your own is on both sides, and the local blob
                            // read is faster and works offline.
                            remote={
                              !open.projectPath && open.remoteProjectId
                                ? { projectId: open.remoteProjectId, sessionId: open.sessionId }
                                : null
                            }
                            remoteProjectId={open.remoteProjectId ?? null}
                            focusCommitSha={open.commitSha}
                            // Grounded chat about this Session. Its button is
                            // in the reader's footer with the other actions on
                            // the record; the panel it opens is this pane's.
                            chatOpen={chatOpen}
                            onToggleChat={() => setChatOpen((v) => !v)}
                          />
                        </div>
                        <aside
                          className="atlas-split shrink-0 overflow-hidden border-l border-[var(--border)]"
                          style={{ width: chatOpen ? panelWidth : 0 }}
                          aria-hidden={!chatOpen}
                        >
                          {/* Fixed inner width so the content does not reflow
                           *  through the animation — a panel that re-wraps every
                           *  frame while opening reads as a glitch, not a
                           *  transition. */}
                          <div style={{ width: panelWidth }} className="h-full">
                            {chatOpen && (
                              <SessionChatPanel
                                detail={detail}
                                projectPath={open.projectPath}
                                remoteProjectId={open.remoteProjectId ?? null}
                                onClose={() => setChatOpen(false)}
                              />
                            )}
                          </div>
                        </aside>
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            )}
          </main>
        </div>
      </div>
    </div>
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
