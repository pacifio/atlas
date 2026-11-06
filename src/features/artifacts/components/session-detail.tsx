import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

import type { SessionDetail as Detail } from "../types";
import { EMPTY_DIRECTORY } from "../lib/author-directory";
import {
  FocusThreadContext,
  RemoteSourceContext,
  type RemoteSource,
  type RowComments,
} from "../lib/session-detail-context";
import { useSessionDetail } from "../lib/use-session-detail";
import { CommentsMorph } from "./comments-morph";
import { ExportButton } from "./export-button";
import { FooterPill, PILL_BUTTON, PILL_BUTTON_ACTIVE, PILL_ICON } from "./footer-pill";
import { Masthead } from "./session-masthead";
import { ShareMorph } from "./share-morph";
import { FilterMenu } from "./views/session-filter-menu";
import { Empty, Timeline } from "./views/session-timeline-view";
import { HintItem } from "@tryatlas/design";

export type { RemoteSource, RowComments } from "../lib/session-detail-context";

/**
 * One Session, as the ordered record of what happened.
 *
 * A reading surface, not a table. The content sits in a centred measure with the
 * timeline as a **thin rail in the gutter** — a hairline with a small node per
 * entry — so the shape of a turn is scannable without reading a word, and the
 * prose keeps the full width of the column. The previous version boxed every
 * entry, which made a long Session a stack of cards and buried the one thing
 * that matters: the sequence.
 *
 * Only two things get a card: a **code/data block** (mono, needs its own
 * boundary) and a **Checkpoint** (a commit is a boundary in the Session, not
 * another row in it). Everything else is prose on the page.
 *
 * Long Sessions are windowed: the first 300 visible entries render, and more are
 * appended as the scroll approaches the bottom. Deliberately slice-based rather
 * than a virtualizer — entries expand and collapse, so measured-height
 * virtualization would fight the content, and a Session being *read* is scrolled
 * forward, not randomly accessed. Jumping to a Checkpoint extends the window
 * first.
 *
 * Everything shown is already redacted. Scrubbing happened before persistence,
 * so there is no way for this component to leak something the store does not
 * already hold.
 */

/**
 * The reading measure. Prose past ~90 characters is measurably harder to scan.
 *
 * The horizontal padding is symmetric on purpose, so the column reads as a
 * measure rather than an indent — and it is sized against the CONTAINER, not
 * the window. This view now opens in a dock beside the board as well as at
 * full width, and 56px either side of a 600px panel is a third of it spent on
 * margin.
 */
const MEASURE = "mx-auto w-full max-w-[920px] px-5 @2xl:px-8 @4xl:px-14";

interface Props {
  detail: Detail;
  /** Needed to fetch spilled payloads via `artifacts_payload`. */
  projectPath: string;
  /** `null` when the Session is local-only. */
  comments?: RowComments | null;
  /** The masthead is painted from the board row and the timeline is still on
   *  its way. Without it an empty `entries` reads as "nothing was recorded". */
  entriesPending?: boolean;
  /** Part of the timeline is here and the rest is still arriving (a remote
   *  Session streamed page by page). */
  entriesStreaming?: boolean;
  /** Set only for a Session with no local copy — see [`RemoteSourceContext`]. */
  remote?: RemoteSource | null;
  /**
   * The server Project this Session belongs to, when it has one.
   *
   * NOT the same question as `remote` above, which is only set when there is
   * no LOCAL copy to read payloads from. A Session of your own that has been
   * pushed is on both sides: `remote` is null for it and it is still shared,
   * which is why sharing cannot be driven off that flag.
   */
  remoteProjectId?: string | null;
  /** Opened from a commit: land on that Checkpoint rather than at the top. */
  focusCommitSha?: string;
  /** Opened from the inbox: land on this comment's thread and open it. */
  focusAnchor?: { kind: string; id: string };
  /** Whether the grounded chat is open beside the record. The panel is the
   *  pane's; the button that opens it is in this footer. */
  chatOpen?: boolean;
  /** Open or close it. Absent, the footer has no Ask button. */
  onToggleChat?: () => void;
}

export function SessionDetail({
  detail,
  projectPath,
  comments = null,
  entriesPending = false,
  entriesStreaming = false,
  remote = null,
  remoteProjectId = null,
  focusCommitSha,
  focusAnchor,
  chatOpen = false,
  onToggleChat,
}: Props) {
  const {
    filters,
    setFilters,
    failedOnly,
    setFailedOnly,
    tools,
    setTools,
    expandTools,
    setExpandTools,
    foldResponses,
    setFoldResponses,
    search,
    setSearch,
    renderCount,
    scrollRef,
    contentRef,
    focusStore,
    groups,
    rendered,
    checkpoints,
    failedCount,
    register,
    more,
    onScroll,
    landed,
    setPendingJump,
    jumpToThread,
    activeFilters,
    currentCheckpoint,
  } = useSessionDetail({ detail, entriesStreaming, focusCommitSha, focusAnchor });

  const s = detail.summary;

  return (
    <RemoteSourceContext.Provider value={remote}>
      <FocusThreadContext.Provider value={focusStore}>
        <div className="relative flex h-full min-h-0">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto"
          >
            <div ref={contentRef} className={cn(MEASURE, "pb-28 pt-14")}>
              <Masthead detail={detail} comments={comments} projectPath={projectPath} />

              {groups.length === 0 ? (
                <Empty
                  detail={detail}
                  pending={entriesPending}
                  failedOnly={failedOnly}
                  failedCount={failedCount}
                />
              ) : (
                <div className="mt-14">
                  <Timeline
                    groups={rendered}
                    projectPath={projectPath}
                    sessionId={s.id}
                    agent={s.agent}
                    expandTools={expandTools}
                    landed={landed}
                    register={register}
                    comments={comments}
                  />
                  {renderCount < groups.length ? (
                    <p className="py-6 text-center font-mono text-xs text-[var(--muted-foreground)]">
                      {groups.length - renderCount} more…
                    </p>
                  ) : (
                    entriesStreaming && (
                      <p className="py-6 text-center font-mono text-xs text-[var(--muted-foreground)]">
                        Loading the rest of this session…
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bottom fade — the cue for content below the fold, without the agent
           *  chat's scroll-to-bottom button: a Session is read top-down and the
           *  newest entry is not the destination.
           *
           *  Deeper than the chat's, and fully opaque before the controls rather
           *  than at the very bottom edge: the action bar and the search field float
           *  *on* this, and a linear ramp to the edge left body text legible
           *  straight through both of them. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-20 h-32 transition-opacity duration-200",
              more ? "opacity-100" : "opacity-0",
            )}
            style={{
              background:
                "linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--background) 60%, transparent) 28%, color-mix(in srgb, var(--background) 92%, transparent) 44%, var(--background) 55%)",
            }}
          />

          {/* The action bar: every action on the open Session, in two pills
           *  (`footer-pill.tsx`). Left, hand it on and narrow it — share,
           *  export, filter; right, talk about it — ask, comments. Share and
           *  comments are morphs whose closed box is a button in the pill, so
           *  each panel still grows out of its own button.
           *
           *  `items-end` so a morph grows UP out of its pill while the bar
           *  holds both pills to the bottom edge. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-end justify-between gap-3 px-4 pb-3.5 *:pointer-events-auto">
            <FooterPill>
              <ShareMorph
                detail={detail}
                projectId={remoteProjectId}
                directory={comments?.directory ?? EMPTY_DIRECTORY}
                inPill
              />
              <ExportButton detail={detail} />
              <FilterMenu
                detail={detail}
                filters={filters}
                setFilters={setFilters}
                failedOnly={failedOnly}
                setFailedOnly={setFailedOnly}
                failedCount={failedCount}
                tools={tools}
                setTools={setTools}
                expandTools={expandTools}
                setExpandTools={setExpandTools}
                foldResponses={foldResponses}
                setFoldResponses={setFoldResponses}
                search={search}
                setSearch={setSearch}
                activeFilters={activeFilters}
                checkpoints={checkpoints}
                currentCheckpoint={currentCheckpoint}
                onJump={setPendingJump}
              />
            </FooterPill>
            {(onToggleChat || comments) && (
              <FooterPill>
                {onToggleChat && (
                  <HintItem label={chatOpen ? "Close chat" : "Ask about this session"}>
                    <button
                      type="button"
                      aria-pressed={chatOpen}
                      onClick={onToggleChat}
                      className={cn(PILL_BUTTON, chatOpen && PILL_BUTTON_ACTIVE)}
                    >
                      <Sparkles size={PILL_ICON} strokeWidth={1.7} />
                    </button>
                  </HintItem>
                )}
                {comments && (
                  <CommentsMorph detail={detail} comments={comments} inPill onJump={jumpToThread} />
                )}
              </FooterPill>
            )}
          </div>
        </div>
      </FocusThreadContext.Provider>
    </RemoteSourceContext.Provider>
  );
}
