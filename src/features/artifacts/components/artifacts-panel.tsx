import { useTipOnMount } from "@/features/tips/lib/use-tip-on-mount";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { cn } from "@/lib/utils";

import { useSessionComments } from "../lib/use-session-comments";
import { useArtifactsStore } from "../stores/artifacts-store";
import type { BoardSession } from "../types";
import { activeFacetCount, facetMatches, NO_FACETS, type FacetSelection } from "../lib/board";
import { openKeyOf, useOpenSessionDetail } from "../lib/use-open-session-detail";
import { useTimelineBoard } from "../lib/use-timeline-board";
import { SessionChatPanel } from "./session-chat-panel";
import { SessionDetail } from "./session-detail";
import { BoardFilters } from "./board-filters";
import { SessionReaderHeader } from "./session-reader";
import { TimelineBoard } from "./timeline-board";
import { DetailSkeleton } from "./timeline-skeleton";
import { NotEnabled, NotFound } from "./views/timeline-empty-states";

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

export function ArtifactsPanel() {
  useTipOnMount("timeline");
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
  const { sessions, loaded, error, cloudPending } = useTimelineBoard({
    open,
    projectPaths,
    projectsKey,
    projectFilter,
    activeOrganisationId,
    openSession,
    setProjectFilter,
  });
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
   * The board is out of sight while the reader is wide — hidden, NOT unmounted.
   *
   * It used to unmount, so every Ask toggle and every widen/narrow tore down
   * and rebuilt the virtualized board (rows, day headings, context meters):
   * ~100–150ms of work on the click that closed the chat, plus the reader's
   * place in the list lost each time. Hidden, it costs nothing to keep and
   * comes back exactly where it was.
   *
   * Hidden by `visibility`, out of the flow, at the width it has beside the
   * dock — NOT `display: none`. The board is virtualized, and under
   * `display: none` every row measures 0px tall, so the virtualizer concludes
   * the whole list fits and mounts all of it: a 2.5s freeze on a 400-row board.
   * At its own width nothing it measures changes, so hiding it does no work.
   */
  const boardHidden = Boolean(open) && dockWide;

  /** The dock's width beside the board. Never more than most of the tab: the
   *  board has to stay readable, or the split has stopped being one. */
  const narrowDockWidth = Math.min(620, Math.round(mainWidth * 0.82));
  const dockWidth = useMemo(() => {
    if (mainWidth === 0) return 0;
    // Wide covers the chat too — opening it hides the board rather than
    // splitting the tab three ways.
    if (dockWide) return mainWidth;
    return narrowDockWidth;
  }, [mainWidth, dockWide, narrowDockWidth]);

  // A different Session is a different conversation; the chat does not
  // follow you into it.
  useEffect(() => {
    setChatOpen(false);
  }, [open?.sessionId]);
  const { detail, entriesPending, entriesStreaming, detailError } = useOpenSessionDetail({
    open,
    sessions,
    loaded,
  });

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
      {error && <p className="shrink-0 bg-error-muted px-4 py-1.5 text-xs text-error">{error}</p>}

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
            {sessions.length === 0 && loaded && !cloudPending ? (
              !boardHidden && <NotEnabled />
            ) : (
              <div
                inert={boardHidden}
                aria-hidden={boardHidden || undefined}
                className={cn(
                  "flex min-h-0 min-w-0 flex-1",
                  boardHidden && "invisible absolute inset-y-0 left-0",
                )}
                style={boardHidden ? { width: mainWidth - narrowDockWidth } : undefined}
              >
                <TimelineBoard
                  sessions={visible}
                  directory={directory}
                  openKey={open ? openKeyOf(open) : null}
                  loading={!loaded || cloudPending}
                  narrowed={narrowed}
                  query={query}
                  onQuery={setQuery}
                  onOpen={onOpenRow}
                  // The filters are portalled into the titlebar, so a hidden
                  // board must not leave them there.
                  filters={boardHidden ? null : filterMenu}
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
              </div>
            )}

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
                            entriesStreaming={entriesStreaming}
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
                            focusAnchor={open.anchor}
                            // Grounded chat about this Session. Its button is
                            // in the reader's footer with the other actions on
                            // the record; the panel it opens is this pane's.
                            chatOpen={chatOpen}
                            onToggleChat={() => setChatOpen((v) => !v)}
                          />
                        </div>
                        {chatOpen && (
                          // At its full width from the first frame, so the
                          // record beside it reflows once; only the content
                          // slides in (`.atlas-split-in`, transform + opacity).
                          <aside
                            className="shrink-0 overflow-hidden border-l border-[var(--border)]"
                            style={{ width: CHAT_WIDTH }}
                          >
                            <div style={{ width: CHAT_WIDTH }} className="atlas-split-in h-full">
                              <SessionChatPanel
                                detail={detail}
                                projectPath={open.projectPath}
                                remoteProjectId={open.remoteProjectId ?? null}
                                onClose={() => setChatOpen(false)}
                              />
                            </div>
                          </aside>
                        )}
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
