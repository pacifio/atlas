import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  Filter,
  Download,
  GitCommitHorizontal,
  Loader2,
  Search,
  Sparkles,
  TriangleAlert,
  User,
  X,
} from "lucide-react";

import { AtlasIcon } from "@/components/atlas-icon";
import { extractInjectedContext, type InjectedBlock } from "@/features/chat/lib/atlas-context";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

import {
  DEFAULT_FILTERS,
  type ArtifactPayload,
  type SessionDetail as Detail,
  type TimelineEntry,
  type TimelineFilters,
} from "../types";
import {
  agentLabel,
  formatDuration,
  prettyModel,
  sessionTitle,
  tokenBreakdown,
  tokenLabel,
} from "../lib/board";
import { exportSession, type ExportFormat } from "../lib/export";
import { observeSize } from "../lib/shared-resize-observer";
import { animatedScrollTo } from "../lib/scroll-to";
import { useTimelineScroll } from "../lib/use-timeline-scroll";
import { CodeBlock, CopyButton, prettyJson } from "./code-block";
import { JUMP_EVENT, type JumpDetail } from "./session-chat-message";
import { AgentGlyph } from "./session-list";

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
 * How many visible entries render before the window has to grow.
 *
 * Small on purpose. A Session runs to hundreds of entries and each one may carry
 * markdown, a highlighted payload, or a call table — 300 of those is a second of
 * blocked main thread before anything appears, to fill a viewport that holds
 * about eight. The rest arrive on scroll, well ahead of the fold.
 */
const WINDOW_CHUNK = 40;

/** Half the tallest rail node — where the hairline starts and stops. */
const NODE_CENTRE = 16;

/**
 * The reading measure. Prose past ~90 characters is measurably harder to scan.
 *
 * The horizontal padding is not decorative: the navigation rail is an absolute
 * overlay at `left: 0` about 40px wide including its fade, and it sits *over*
 * this column. At `px-8` the first character of every line was inside the rail's
 * gradient — legible, but reading as though the text had run into the furniture.
 * 56px clears the rail with room to spare on the left, and stays symmetric so
 * the column still reads as a measure rather than an indent.
 */
const MEASURE = "mx-auto w-full max-w-[920px] px-14";

type Tab = "activity" | "tools";

interface Props {
  detail: Detail;
  /** Needed to fetch spilled payloads via `artifacts_payload`. */
  projectPath: string;
  /** Opened from a commit: land on that Checkpoint rather than at the top. */
  focusCommitSha?: string;
  /** Whether the grounded chat occupies the other half of the split. */
  chatOpen?: boolean;
  onToggleChat?: () => void;
}

export function SessionDetail({
  detail,
  projectPath,
  focusCommitSha,
  chatOpen,
  onToggleChat,
}: Props) {
  const [tab, setTab] = useState<Tab>("activity");
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  /** Narrow tool calls to failed ones — the "which calls failed" question. */
  const [failedOnly, setFailedOnly] = useState(false);
  /** Which canonical tool names are selected. Empty means all. */
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** Keep every tool-call group open. Off by default — see `Calls`. */
  const [expandTools, setExpandTools] = useState(false);
  /** Show every response, or only the last of each consecutive run. */
  const [foldResponses, setFoldResponses] = useState(false);
  /** Free-text narrowing of the timeline. */
  const [search, setSearch] = useState("");
  const [renderCount, setRenderCount] = useState(WINDOW_CHUNK);
  const entryRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Cancels the jump animation in flight, if any. */
  const cancelScroll = useRef<(() => void) | null>(null);

  /**
   * Carry the reader to an entry.
   *
   * Not `scrollIntoView`: rows carry `content-visibility: auto`, so the ones a
   * jump passes over are laid out for the first time *during* the scroll — and
   * a single sampled destination is wrong by the time the animation reaches it.
   * See `animatedScrollTo`.
   */
  const jumpTo = useCallback((node: HTMLElement, block: "start" | "center") => {
    const container = scrollRef.current;
    if (!container) return;
    cancelScroll.current?.();
    cancelScroll.current = animatedScrollTo(container, node, {
      block,
      offset: 12,
    });
  }, []);

  useEffect(() => () => cancelScroll.current?.(), []);
  /** A jump target waiting for its entry to be rendered. */
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  /** The entry a jump just landed on, highlighted briefly. */
  const [landed, setLanded] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const s = detail.summary;

  /**
   * Entries with identity carried across detail re-reads.
   *
   * A LIVE Session re-reads its detail on every board refresh (a 15 s poll plus
   * git/capture events), and each read deserializes a brand-new object for every
   * entry — so every memo downstream rebuilt and every rendered `Row` re-rendered
   * to display an unchanged record. The capture log is append-only: an entry with
   * the same id is the same entry unless one of the few mutable facts about it
   * moved (a tool completing, a body growing past its preview). Those are cheap
   * to check, so a poll that appended one turn re-renders one row.
   */
  const prevEntries = useRef(new Map<string, TimelineEntry>());
  const entries = useMemo(() => {
    const prev = prevEntries.current;
    const next = new Map<string, TimelineEntry>();
    const shared = detail.entries.map((entry) => {
      const old = prev.get(entry.id);
      const reuse =
        old &&
        old.kind === entry.kind &&
        old.toolStatus === entry.toolStatus &&
        old.truncated === entry.truncated &&
        old.linkState === entry.linkState &&
        old.commitSubject === entry.commitSubject &&
        (old.text?.length ?? 0) === (entry.text?.length ?? 0) &&
        (old.arguments?.length ?? 0) === (entry.arguments?.length ?? 0) &&
        (old.result?.length ?? 0) === (entry.result?.length ?? 0);
      const kept = reuse ? old : entry;
      next.set(entry.id, kept);
      return kept;
    });
    prevEntries.current = next;
    return shared;
  }, [detail.entries]);

  // Deferred, not raw: filtering runs over every entry's payload, and doing
  // that synchronously per keystroke made typing in the search field pay for
  // the whole scan. The input stays controlled by `search` (echoes instantly);
  // the scan follows a beat behind.
  const deferredSearch = useDeferredValue(search);

  const visible = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return entries.filter(
      (entry) => passes(entry, filters, failedOnly, tools) && matches(entry, needle),
    );
  }, [entries, filters, failedOnly, tools, deferredSearch]);

  /** Every tool call, unfiltered by kind — the Tool calls tab's own list. */
  const allCalls = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.kind === "tool_call" &&
          (!failedOnly || entry.toolStatus === "failed") &&
          (tools.size === 0 || tools.has(entry.toolName ?? "Other")),
      ),
    [entries, failedOnly, tools],
  );

  /** Every Checkpoint, unfiltered — the jump list must reach a commit even when
   *  the current filter hides Checkpoints from the timeline. */
  const checkpoints = useMemo(
    () => entries.filter((entry) => entry.kind === "checkpoint"),
    [entries],
  );

  const failedCount = useMemo(
    () =>
      entries.filter((entry) => entry.kind === "tool_call" && entry.toolStatus === "failed").length,
    [entries],
  );

  /**
   * Consecutive tool calls collapse into one group.
   *
   * A turn routinely fires twenty calls in a row. As twenty timeline nodes they
   * drown the two sentences either side of them; as one node with a table, the
   * turn keeps its shape.
   *
   * Groups get the same identity-sharing as entries: a rebuilt group whose
   * member entries are the SAME objects as last time is returned as the
   * previous object, so `Row`'s memo holds across live-session polls and
   * unrelated state changes.
   */
  const prevGroups = useRef(new Map<string, Group>());
  const groups = useMemo(() => {
    const built = groupEntries(foldResponses ? foldRuns(visible) : visible);
    const prev = prevGroups.current;
    const next = new Map<string, Group>();
    const out = built.map((group) => {
      const old = prev.get(group.id);
      const reuse =
        old &&
        old.kind === group.kind &&
        old.entries.length === group.entries.length &&
        old.entries.every((e, i) => e === group.entries[i]);
      const kept = reuse ? old : group;
      next.set(group.id, kept);
      return kept;
    });
    prevGroups.current = next;
    return out;
  }, [visible, foldResponses]);

  /**
   * The rail's ticks: one per prompt.
   *
   * A prompt is where a person last spoke, which is the only landmark in a
   * Session a reader can navigate by — responses and tool calls are the answer
   * to one, not a place of their own.
   */
  const anchors = useMemo(
    () =>
      groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => group.kind === "prompt")
        .map(({ group, index }) => ({
          id: group.id,
          index,
          preview: (group.entries[0].text ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        })),
    [groups],
  );
  /** Live nodes for the rendered anchors, in render order. */
  const anchorRefs = useRef(new Map<number, HTMLDivElement>());

  /**
   * Registering a row's node.
   *
   * Stable on purpose. A ref callback that changes identity is torn down and
   * re-run on *every* render — React calls the old one with `null` and the new
   * one with the node — so an inline arrow here meant a Map churn plus an
   * `anchors` lookup for every rendered row every time any state changed, in
   * the middle of scrolling. The anchor list is read through a ref so the
   * callback never has to be rebuilt when it changes.
   */
  const anchorIndex = useRef(new Map<string, number>());
  anchorIndex.current = useMemo(() => {
    const map = new Map<string, number>();
    anchors.forEach((anchor, i) => map.set(anchor.id, i));
    return map;
  }, [anchors]);

  const register = useCallback((id: string, node: HTMLDivElement | null) => {
    const rail = anchorIndex.current.get(id);
    if (node) {
      entryRefs.current.set(id, node);
      if (rail !== undefined) anchorRefs.current.set(rail, node);
    } else {
      entryRefs.current.delete(id);
      if (rail !== undefined) anchorRefs.current.delete(rail);
    }
  }, []);

  const { more, activeAnchor, onScroll, invalidate } = useTimelineScroll({
    scrollRef,
    contentRef,
    anchorRefs,
    anchorCount: anchors.length,
    canGrow: renderCount < groups.length,
    onGrow: useCallback(
      () => setRenderCount((count) => Math.min(count + WINDOW_CHUNK, groups.length)),
      [groups.length],
    ),
  });

  /** The next prompt below the reader — the action bar's forward jump. */
  const nextAnchor = anchors[Math.min(activeAnchor + 1, anchors.length - 1)];

  /** Scroll to a rail tick, growing the window first if it is past the fold. */
  const jumpToAnchor = useCallback(
    (anchor: { id: string; index: number }) => {
      if (anchor.index >= renderCount) {
        setRenderCount(Math.min(anchor.index + WINDOW_CHUNK, groups.length));
        setPendingJump(anchor.id);
        return;
      }
      const node = entryRefs.current.get(anchor.id);
      if (node) jumpTo(node, "start");
    },
    [renderCount, groups.length, jumpTo],
  );

  // A new Session or a filter change restarts the window from the top.
  // Keyed to the DEFERRED search so the reset lands with the results it belongs
  // to — resetting on the raw keystroke scrolled to top a beat before the list
  // changed.
  useEffect(() => {
    setRenderCount(WINDOW_CHUNK);
    scrollRef.current?.scrollTo({ top: 0 });
    // The list was swapped wholesale; a same-height replacement would not trip
    // the ResizeObserver and every cached offset would describe the old rows.
    invalidate();
  }, [detail.summary.id, filters, failedOnly, tools, deferredSearch, foldResponses, invalidate]);

  // Memoised, and load-bearing: this array is `Timeline`'s only changing prop,
  // so a fresh slice on every render would fail its memo comparison every time
  // and re-render the whole window on every scroll tick — exactly what the memo
  // exists to prevent.
  const rendered = useMemo(() => groups.slice(0, renderCount), [groups, renderCount]);

  // Jump-to-Checkpoint has to survive both a filter that hides Checkpoints and a
  // window that has not reached the target yet, so it settles over renders:
  // reveal the kind, grow the window, then scroll.
  useEffect(() => {
    if (!pendingJump) return;
    const index = groups.findIndex((g) => g.entries.some((e) => e.id === pendingJump));
    if (index === -1) {
      setFilters((current) => (current.checkpoints ? current : { ...current, checkpoints: true }));
      return;
    }
    if (index >= renderCount) {
      setRenderCount(index + 40);
      return;
    }
    const node = entryRefs.current.get(pendingJump);
    if (node) {
      jumpTo(node, "center");
      // A smooth scroll into the middle of a long conversation leaves no clue
      // which row was the destination. The ring says "this one", then gets out
      // of the way.
      setLanded(pendingJump);
      setPendingJump(null);
    }
  }, [pendingJump, groups, renderCount, jumpTo]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), 2000);
    return () => clearTimeout(timer);
  }, [landed]);

  // Arrived from a commit in the git panel. That commit is the only part of the
  // Session the developer asked about, and a Session can produce several — so
  // opening at the top would land them in the wrong conversation.
  //
  // Honoured once per arrival. A live Session re-reads its entries every poll,
  // and without the guard each one would yank the reader back to the Checkpoint
  // they had already scrolled away from.
  // A citation chip in the chat jumps the timeline. An event rather than a prop
  // so the chat needs no handle on this component's internals — the same
  // machinery that serves an arrival from the git panel serves this.
  useEffect(() => {
    const onJump = (e: Event) => {
      const detailPayload = (e as CustomEvent<JumpDetail>).detail;
      if (!detailPayload) return;
      setTab("activity");
      if (detailPayload.entryId) {
        setPendingJump(detailPayload.entryId);
        return;
      }
      if (detailPayload.commitSha) {
        const target = detail.entries.find(
          (entry) => entry.kind === "checkpoint" && entry.commitSha === detailPayload.commitSha,
        );
        if (target) setPendingJump(target.id);
      }
    };
    window.addEventListener(JUMP_EVENT, onJump);
    return () => window.removeEventListener(JUMP_EVENT, onJump);
  }, [detail.entries]);

  const honouredFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusCommitSha) return;
    const arrival = `${detail.summary.id}:${focusCommitSha}`;
    if (honouredFocus.current === arrival) return;
    const target = detail.entries.find(
      (entry) => entry.kind === "checkpoint" && entry.commitSha === focusCommitSha,
    );
    if (target) {
      honouredFocus.current = arrival;
      setTab("activity");
      setPendingJump(target.id);
    }
  }, [focusCommitSha, detail.summary.id, detail.entries]);

  const activeFilters =
    (filters.prompts ? 0 : 1) +
    (filters.responses ? 0 : 1) +
    (filters.thinking ? 1 : 0) +
    (filters.toolCalls ? 0 : 1) +
    (filters.checkpoints ? 0 : 1) +
    (failedOnly ? 1 : 0) +
    tools.size;

  return (
    <div className="relative flex h-full min-h-0">
      {/* The navigation rail, matching the agent chat: one tick per prompt,
       *  vertically centred, the active one widened. Two ticks is the floor —
       *  a rail with one mark on it navigates nothing. */}
      {tab === "activity" && anchors.length > 1 && (
        <div className="pointer-events-none absolute left-0 top-1/2 z-[35] -translate-y-1/2">
          <div className="pointer-events-none absolute inset-y-[-12px] left-0 w-10 bg-gradient-to-r from-[var(--bg-surface)] via-[var(--bg-surface)]/70 to-transparent" />
          {/* Ticks only — no hover tooltip. The previews kept one mounted
           *  `backdrop-filter` element PER PROMPT stacked over the scroller
           *  (opacity-0 still composites), which is exactly the blur cost this
           *  codebase keeps relearning. The tick jumps; the prompt itself is
           *  one click away, and `aria-label` keeps the preview for assistive
           *  tech where it costs nothing. */}
          <div className="relative flex flex-col justify-center gap-1.5 py-2 pl-2 pr-4">
            {anchors.map((anchor, i) => (
              <button
                key={anchor.id}
                type="button"
                aria-label={anchor.preview || "Jump to prompt"}
                onClick={() => jumpToAnchor(anchor)}
                className="group pointer-events-auto relative flex cursor-pointer items-center"
              >
                <span
                  className={cn(
                    "h-0.5 rounded-full transition-all duration-200 ease-out",
                    i === activeAnchor
                      ? "w-4 bg-[var(--accent-primary)]"
                      : "w-2 bg-[var(--text-tertiary)]/40 group-hover:w-3 group-hover:bg-[var(--text-tertiary)]",
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="hide-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className={cn(MEASURE, "pb-28 pt-7")}>
          <Masthead detail={detail} />

          <div className="mt-5 flex items-center gap-1.5">
            <TabButton
              active={tab === "activity"}
              count={detail.entries.length}
              onClick={() => setTab("activity")}
            >
              Activity
            </TabButton>
            <TabButton
              active={tab === "tools"}
              count={s.toolCallCount}
              onClick={() => setTab("tools")}
            >
              Tool calls
            </TabButton>
          </div>

          {tab === "activity" ? (
            groups.length === 0 ? (
              <Empty detail={detail} failedOnly={failedOnly} failedCount={failedCount} />
            ) : (
              <div className="mt-6">
                <Timeline
                  groups={rendered}
                  projectPath={projectPath}
                  agent={s.agent}
                  expandTools={expandTools}
                  landed={landed}
                  register={register}
                />
                {renderCount < groups.length && (
                  <p className="py-6 text-center font-mono text-[11px] text-[var(--text-tertiary)]">
                    {groups.length - renderCount} more…
                  </p>
                )}
              </div>
            )
          ) : (
            <CallTable calls={allCalls} projectPath={projectPath} />
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
            "linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--bg-surface) 60%, transparent) 28%, color-mix(in srgb, var(--bg-surface) 92%, transparent) 44%, var(--bg-surface) 55%)",
        }}
      />

      {/* The action bar. Floating over the fade rather than docked below the
       *  scroller: the measure is centred and a full-width toolbar would put its
       *  controls further from the text than the text is wide. Left is what
       *  changes the view, right is what moves through it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center gap-3 px-4 pb-3.5">
        <BarButton
          label="Filters"
          active={filtersOpen || activeFilters > 0}
          badge={activeFilters > 0 ? activeFilters : undefined}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <Filter size={14} strokeWidth={1.6} />
        </BarButton>

        {/* The search field, between the two control clusters and centred in the
         *  measure. Same pill as the memory Timeline's: floating, blurred, no
         *  box around it — it belongs to the content, not to a toolbar. */}
        <div className="pointer-events-auto mx-auto flex h-11 min-w-0 max-w-[620px] flex-1 items-center gap-2.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/70 px-4 shadow-[var(--shadow-overlay)] backdrop-blur-2xl">
          <Search size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
            placeholder="Search this session…"
            spellCheck={false}
            aria-label="Search this session"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {search && (
            <>
              <span className="shrink-0 font-mono text-[11px] text-[var(--text-ghost)]">
                {groups.length}
              </span>
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>

        <div className="pointer-events-auto flex items-center rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/70 shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          <BarButton
            label="Next prompt"
            bare
            disabled={!nextAnchor || activeAnchor >= anchors.length - 1}
            onClick={() => nextAnchor && jumpToAnchor(nextAnchor)}
          >
            <ChevronsDown size={14} strokeWidth={1.6} />
          </BarButton>
          <span aria-hidden className="h-4 w-px bg-[var(--border-default)]" />
          <BarButton
            label={chatOpen ? "Close chat" : "Ask about this session"}
            bare
            active={chatOpen}
            disabled={!onToggleChat}
            onClick={onToggleChat}
          >
            <Sparkles size={14} strokeWidth={1.6} />
          </BarButton>
        </div>
      </div>

      {filtersOpen && (
        <FilterDrawer
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
          activeFilters={activeFilters}
          checkpoints={checkpoints}
          onJump={(entryId) => {
            // The drawer closes on jump. It covers the right third of the
            // measure, and landing behind it would mean the reader has to
            // dismiss it to see what they asked for.
            setFiltersOpen(false);
            setTab("activity");
            setPendingJump(entryId);
          }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </div>
  );
}

// ── Masthead ────────────────────────────────────────────────────────────────

/** Title, identity chips, and the four numbers worth leading with. */
function Masthead({ detail }: { detail: Detail }) {
  const s = detail.summary;
  const branch = s.branches[0];
  const tokens = tokenLabel(s);

  return (
    <>
      <h1 className="text-[26px] font-semibold leading-[1.2] tracking-[-0.03em] text-[var(--text-primary)]">
        {sessionTitle(s.title) ?? (
          <span className="text-[var(--text-tertiary)]">Untitled session</span>
        )}
      </h1>

      <div className="mt-3 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {s.agent && <AgentChip agent={s.agent} />}
          {s.source === "external_jsonl" && (
            <Chip>
              <Download size={11} />
              imported
            </Chip>
          )}
          {branch && (
            <Chip>
              <GitCommitHorizontal size={11} />
              {branch}
            </Chip>
          )}
          <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">
            {timeAgo(s.lastActivityAt, { suffix: true })} · {formatDuration(s.activeSeconds)}
          </span>
          {s.needsAttention && (
            <span
              className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--status-warning)]/25 bg-[var(--status-warning-muted)] px-2.5 font-mono text-[10.5px] text-[var(--status-warning)]"
              title={s.attentionReason ?? undefined}
            >
              <TriangleAlert size={11} />
              partial
            </span>
          )}
        </div>
        <ExportButton detail={detail} />
      </div>

      <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-md border border-[var(--border-default)]">
        <Metric label="Active" value={formatDuration(s.activeSeconds)} sub={clock(s)} />
        <Metric
          label="Tokens"
          value={tokens ?? "—"}
          sub={tokenBreakdown(s) ?? (s.contextUsed != null ? "context window" : "not reported")}
          divided
        />
        <Metric
          label="Turns"
          value={String(detail.counts.prompts + detail.counts.responses)}
          sub={`${detail.counts.prompts} prompt${detail.counts.prompts === 1 ? "" : "s"}`}
          divided
        />
        <Metric
          label="Tool calls"
          value={String(s.toolCallCount)}
          sub={
            detail.counts.checkpoints > 0
              ? `${detail.counts.checkpoints} checkpoint${detail.counts.checkpoints === 1 ? "" : "s"}`
              : "no commits linked"
          }
          divided
        />
      </div>
    </>
  );
}

/**
 * Take the Session out of Atlas.
 *
 * Two formats, because there are two reasons to want one — the machine-readable
 * record and the one you paste into a ticket — and the choice is one click deep
 * rather than a dialog, since neither is the obvious default.
 */
function ExportButton({ detail }: { detail: Detail }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [open, setOpen] = useState(false);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    try {
      await exportSession(detail, format);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Export session"
          aria-label="Export session"
          disabled={busy !== null}
          className="ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} strokeWidth={1.7} />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[var(--z-max)] w-[184px] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 p-1 shadow-[var(--shadow-overlay)] backdrop-blur-2xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          <ExportItem onClick={() => void run("md")} label="Markdown" hint=".md" />
          <ExportItem onClick={() => void run("json")} label="JSON" hint=".json" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExportItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {label}
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-[var(--text-ghost)]">{hint}</span>
    </button>
  );
}

function Metric({
  label,
  value,
  sub,
  divided,
}: {
  label: string;
  value: string;
  sub: string;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 bg-[var(--bg-raised)] px-3.5 py-3",
        divided && "border-l border-[var(--border-default)]",
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {label}
      </p>
      <p className="mt-1.5 truncate font-mono text-[17px] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
        {value}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-ghost)]">{sub}</p>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-raised)] px-2.5 font-mono text-[10.5px] text-[var(--text-tertiary)]">
      {children}
    </span>
  );
}

/**
 * The agent, in monochrome.
 *
 * The composer badges its agent without a brand tint and this row now matches:
 * on a masthead that already carries a title, a branch, a duration and a state
 * chip, a coloured pill was the loudest thing on the line and the least
 * important — the agent is *identity*, not *status*, and the mark alone says it.
 */
function AgentChip({ agent }: { agent: string }) {
  return (
    <Chip>
      <span className="text-[var(--text-secondary)]">
        <AgentGlyph agent={agent} mono />
      </span>
      {agentLabel(agent).toLowerCase()}
    </Chip>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

interface Group {
  id: string;
  kind: TimelineEntry["kind"];
  entries: TimelineEntry[];
}

/**
 * Keep only the last response of each consecutive run.
 *
 * An agent narrates as it works — "let me check X", "now Y", then the actual
 * answer. Reading a finished Session, the narration is scaffolding and the last
 * message of a run is the conclusion. Folding to it turns a forty-message
 * transcript into the handful of statements that survived.
 *
 * Deliberately per *run*, not per turn: a run ends at the next prompt, tool call
 * or Checkpoint, so a response that comes after real work is kept even if
 * another response follows later. The alternative — one response per turn —
 * would silently drop the conclusion of every turn that ended in a commit.
 */
function foldRuns(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "response" && out[out.length - 1]?.kind === "response") {
      out[out.length - 1] = entry;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Fold runs of consecutive tool calls into one group; everything else is its own. */
function groupEntries(entries: TimelineEntry[]): Group[] {
  const out: Group[] = [];
  for (const entry of entries) {
    const tail = out[out.length - 1];
    if (entry.kind === "tool_call" && tail?.kind === "tool_call") {
      tail.entries.push(entry);
      continue;
    }
    out.push({ id: entry.id, kind: entry.kind, entries: [entry] });
  }
  return out;
}

/**
 * The rendered window of the timeline.
 *
 * Split out and memoised because the scroll loop publishes two pieces of state
 * — the fade's `more` and the rail's `activeAnchor` — and without this boundary
 * every tick of either re-rendered every row, every code block and every
 * markdown body in the window. Now a scroll that changes only where the reader
 * is re-renders the rail and the fade, and the list is skipped outright.
 *
 * `landed` is the one prop that still moves per row, and it moves once per jump.
 */
const Timeline = memo(function Timeline({
  groups,
  projectPath,
  agent,
  expandTools,
  landed,
  register,
}: {
  groups: Group[];
  projectPath: string;
  agent: string | null;
  expandTools: boolean;
  landed: string | null;
  register: (id: string, node: HTMLDivElement | null) => void;
}) {
  return (
    <>
      {groups.map((group, i) => (
        <Row
          key={group.id}
          group={group}
          first={i === 0}
          last={i === groups.length - 1}
          projectPath={projectPath}
          agent={agent}
          expandTools={expandTools}
          isLanded={group.entries.some((e) => e.id === landed)}
          register={register}
        />
      ))}
    </>
  );
});

/**
 * One node on the rail plus its content.
 *
 * The rail is a hairline in a 26px gutter, drawn per row and joined by the rows
 * above and below — half-height at the two ends so it starts and stops at a node
 * rather than running off into the page.
 */
const Row = memo(function Row({
  group,
  first,
  last,
  projectPath,
  agent,
  expandTools,
  isLanded,
  register,
}: {
  group: Group;
  first: boolean;
  last: boolean;
  projectPath: string;
  agent: string | null;
  /** The global "always expand" switch from the filter drawer. */
  expandTools: boolean;
  /** A jump just landed here — ringed briefly. */
  isLanded: boolean;
  register: (id: string, node: HTMLDivElement | null) => void;
}) {
  const head = group.entries[0];
  return (
    <div
      ref={(node) => register(head.id, node)}
      className={cn(
        "atlas-entry grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 rounded-md transition-colors",
        isLanded && "ring-1 ring-[var(--border-strong)]",
      )}
    >
      <div className="relative flex justify-center">
        <span
          aria-hidden
          className="absolute left-1/2 -ml-px w-px bg-[var(--border-subtle)]"
          style={{
            top: first ? NODE_CENTRE : 0,
            bottom: last ? `calc(100% - ${NODE_CENTRE}px)` : 0,
          }}
        />
        <Node kind={group.kind} agent={agent} status={head.toolStatus} />
      </div>

      <div className="group/row min-w-0 pb-6">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-[12.5px] font-medium",
              group.kind === "checkpoint"
                ? "text-[var(--capture-live)]"
                : group.kind === "prompt"
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)]",
            )}
          >
            {kindLabel(group)}
          </span>
          <span className="text-[var(--border-strong)]">·</span>
          <span className="font-mono text-[10.5px] text-[var(--text-tertiary)]">
            {time(head.at)}
          </span>
          {group.kind === "tool_call" && group.entries.length > 1 && (
            <span className="font-mono text-[10.5px] text-[var(--text-ghost)]">
              {group.entries.length} calls
            </span>
          )}
          {group.kind === "tool_call" && <CallStat calls={group.entries} />}

          {/* Copy the entry, from the row's own meta line. A prompt and a
           *  response are the two things anyone lifts out of a Session, and
           *  hanging the control off the label keeps it out of the prose. */}
          {(group.kind === "prompt" || group.kind === "response") && head.text && (
            <>
              <span className="flex-1" />
              <CopyButton
                text={head.text}
                className="-my-1 self-center group-hover/row:opacity-100"
              />
            </>
          )}
        </div>

        {group.kind === "tool_call" ? (
          <Calls calls={group.entries} projectPath={projectPath} expandAll={expandTools} />
        ) : group.kind === "checkpoint" ? (
          <Checkpoint entry={head} />
        ) : group.kind === "prompt" ? (
          <Prompt entry={head} projectPath={projectPath} />
        ) : (
          <Clamp>
            <div className="mt-1.5 text-[13px] leading-[1.65] text-[var(--text-secondary)]">
              <Body entry={head} projectPath={projectPath} markdown={group.kind === "response"} />
            </div>
          </Clamp>
        )}
      </div>
    </div>
  );
});

function kindLabel(group: Group): string {
  switch (group.kind) {
    case "prompt":
      return "Prompt";
    case "response":
      return "Response";
    case "thinking":
      return "Thinking";
    case "checkpoint":
      return "Checkpoint";
    case "tool_call":
      return group.entries.length === 1 ? (group.entries[0].toolName ?? "Tool call") : "Tool calls";
  }
}

/** The glyph on the rail. 20px, hairline stroke, generous inset. */
/**
 * The marker on the rail.
 *
 * 32px, which is the size the reference design uses and roughly what an avatar
 * wants to be — the previous 20px read as a bullet point rather than as
 * "someone did this". At this size the agent's own mark is legible, so a
 * response is identifiable by its glyph rather than by reading the label.
 *
 * Opaque, not translucent: the rail hairline runs *behind* every node, and a
 * see-through fill would show the line crossing the glyph.
 */
function Node({
  kind,
  agent,
  status,
}: {
  kind: TimelineEntry["kind"];
  agent: string | null;
  status: TimelineEntry["toolStatus"];
}) {
  const failed = kind === "tool_call" && status === "failed";

  // A tool call is a solid dot — no glyph and no outline. It marks a position on
  // the rail and nothing more; the row beside it carries the meaning. Every
  // other kind keeps its ring, which is what makes turns stand out from the
  // punctuation between them.
  const bare = kind === "tool_call";

  const tone =
    kind === "checkpoint"
      ? "border-[var(--capture-live)]/35 bg-[var(--capture-live)]/10 text-[var(--capture-live)]"
      : failed
        ? // Still legible as a failure without a ring: the fill carries it.
          "bg-[var(--status-error)]/70"
        : bare
          ? "bg-[var(--border-strong)]"
          : // Prompt + response rings at half strength. At full `--border-strong`
            // the outline competed with the glyph inside it, so the rail read as
            // a column of buttons rather than a quiet index of who did what.
            kind === "prompt"
            ? "border-[var(--border-strong)]/50 bg-[var(--bg-elevated-2)] text-[var(--text-secondary)]"
            : kind === "response"
              ? "border-[var(--border-strong)]/50 bg-[var(--bg-elevated-2)] text-[var(--text-secondary)]"
              : "border-[var(--border-default)] bg-[var(--bg-raised)] text-[var(--text-tertiary)]";

  // Tool calls and thinking stay small. They are punctuation between turns, not
  // turns themselves, and giving them an avatar-sized marker would flatten the
  // distinction the rail exists to draw. A bare dot goes smaller still — at 20px
  // an empty circle reads as a missing icon rather than as a mark.
  const minor = kind === "tool_call" || kind === "thinking";

  return (
    <span
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-center rounded-full",
        !bare && "border",
        bare ? "size-2" : minor ? "size-5" : "size-8",
        tone,
      )}
      style={{
        marginTop: bare ? NODE_CENTRE - 4 : minor ? NODE_CENTRE - 10 : 0,
      }}
    >
      {/* Tool calls render a bare ring. A terminal glyph at 10px added ink
          without adding information — the row beside it already says what ran —
          and the empty ring still marks the position on the rail. */}
      {kind === "prompt" ? (
        <User size={15} strokeWidth={1.6} />
      ) : kind === "checkpoint" ? (
        <Check size={15} strokeWidth={2} />
      ) : kind === "tool_call" ? null : kind === "thinking" ? (
        <Brain size={10} strokeWidth={1.7} />
      ) : agent ? (
        <AgentGlyph agent={agent} size={16} />
      ) : (
        <Sparkles size={14} strokeWidth={1.7} />
      )}
    </span>
  );
}

// ── Tool calls ──────────────────────────────────────────────────────────────

/**
 * A turn's tool calls, folded.
 *
 * Closed by default, and that is the point: a turn routinely fires twenty calls
 * and the reader is following the *conversation*. Twenty rows of `Bash Bash
 * Bash` between two paragraphs is the thing that made a Session unreadable, and
 * the summary beside the label already answers the question most of those rows
 * were being scanned for — what did it touch, and by how much.
 *
 * The drawer's switch forces every group open; this local state is the
 * per-group override, seeded from it so flipping the switch opens what is
 * already on screen.
 */
function Calls({
  calls,
  projectPath,
  expandAll,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(expandAll);
  useEffect(() => setOpen(expandAll), [expandAll]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 flex cursor-pointer items-center gap-1 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
      >
        Show tool calls
        <ChevronRight size={12} />
      </button>
    );
  }

  return (
    <>
      <CallTable calls={calls} projectPath={projectPath} compact />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-1.5 flex cursor-pointer items-center gap-1 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
      >
        Hide tool calls
        <ChevronDown size={12} className="rotate-180" />
      </button>
    </>
  );
}

/**
 * What a folded run of calls did, in one line.
 *
 * The counts come from the tool names; the line delta is read out of the
 * recorded **arguments** of each `Edit` / `Write`, which is the only place it
 * exists — a tool call carries no diffstat of its own, and the Session's
 * insertions belong to its Checkpoints, not to any one turn. Derived, therefore
 * exact for what was recorded and silent when nothing was.
 */
function CallStat({ calls }: { calls: TimelineEntry[] }) {
  const stat = useMemo(() => summarise(calls), [calls]);
  if (!stat.parts.length && !stat.added && !stat.removed) return null;
  return (
    <>
      {stat.parts.length > 0 && (
        <span className="truncate font-mono text-[10.5px] text-[var(--text-ghost)]">
          {stat.parts.join(" · ")}
        </span>
      )}
      {stat.added > 0 && (
        <span className="font-mono text-[10.5px] text-[var(--stat-added)]">+{stat.added}</span>
      )}
      {stat.removed > 0 && (
        <span className="font-mono text-[10.5px] text-[var(--stat-removed)]">−{stat.removed}</span>
      )}
    </>
  );
}

/** Tools that change a file, versus tools that only look at one. */
const WRITERS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor"]);
const READERS = new Set(["Read", "Grep", "Glob", "List", "LS", "Search"]);

function summarise(calls: TimelineEntry[]): {
  parts: string[];
  added: number;
  removed: number;
} {
  const edited = new Set<string>();
  const read = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const call of calls) {
    const name = call.toolName ?? "";
    const target = call.paths[0];
    if (WRITERS.has(name)) {
      if (target) edited.add(target);
      const delta = lineDelta(call.arguments);
      added += delta.added;
      removed += delta.removed;
    } else if (READERS.has(name) && target) {
      read.add(target);
    }
  }

  const parts: string[] = [];
  if (edited.size) parts.push(`${edited.size} modified`);
  if (read.size) parts.push(`${read.size} read`);
  return { parts, added, removed };
}

/**
 * Lines added and removed by one edit, from its arguments.
 *
 * `old_string` / `new_string` are the literal before and after, so their line
 * counts *are* the delta. A `Write` has only `content`, which is all addition.
 * Anything unparseable contributes nothing rather than a guess.
 */
function lineDelta(args: string | null): { added: number; removed: number } {
  if (!args) return { added: 0, removed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { added: 0, removed: 0 };
  }
  const count = (v: unknown) => (typeof v === "string" ? v.split("\n").length : 0);

  let added = 0;
  let removed = 0;
  const visit = (node: Record<string, unknown>) => {
    added += count(node.new_string) + count(node.content);
    removed += count(node.old_string);
  };
  if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    visit(root);
    // MultiEdit nests the real pairs one level down.
    if (Array.isArray(root.edits)) {
      for (const edit of root.edits) {
        if (edit && typeof edit === "object") visit(edit as Record<string, unknown>);
      }
    }
  }
  return { added, removed };
}

/** Calls mounted before the table asks to grow. Generous for the inline group
 *  (a turn rarely fires this many) so the control only ever appears on the Tool
 *  calls tab — which was the one unwindowed list in the feature: a tool-heavy
 *  Session mounted every call as a row in a single commit. */
const CALL_WINDOW = 120;
/** How many more each click reveals. */
const CALL_WINDOW_GROW = 400;

/** The compact call table, shared by the inline group and the Tool calls tab. */
function CallTable({
  calls,
  projectPath,
  compact: dense,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(CALL_WINDOW);
  // One stable handler for every row — the per-row closure was what forced the
  // whole table to re-render on a single expand.
  const toggle = useCallback((id: string) => setOpen((cur) => (cur === id ? null : id)), []);

  // A different call list is a different table — restart the window.
  useEffect(() => setShown(CALL_WINDOW), [calls]);

  if (calls.length === 0) {
    return (
      <p className="py-10 text-center text-[12px] text-[var(--text-tertiary)]">
        No tool calls match the current filters.
      </p>
    );
  }

  const visibleCalls = calls.length > shown ? calls.slice(0, shown) : calls;
  const hidden = calls.length - visibleCalls.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-[var(--border-default)]",
        dense ? "mt-2.5" : "mt-5",
      )}
    >
      {visibleCalls.map((call, i) => (
        <CallRow
          key={call.id}
          call={call}
          dense={dense}
          expanded={open === call.id}
          divider={i < visibleCalls.length - 1 || hidden > 0}
          onToggle={toggle}
          projectPath={projectPath}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((cur) => cur + CALL_WINDOW_GROW)}
          className="flex h-9 w-full cursor-pointer items-center justify-center bg-[var(--bg-raised)] font-mono text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          Show {Math.min(CALL_WINDOW_GROW, hidden)} more of {hidden}…
        </button>
      )}
    </div>
  );
}

/**
 * One call: the summary row, and the recorded payloads when expanded.
 *
 * Memoised so the table's own state changes touch only the rows they concern:
 * expanding a call re-renders that row and the one it closed, not every row in
 * a table that can hold a Session's entire call history.
 */
const CallRow = memo(function CallRow({
  call,
  dense,
  expanded,
  divider,
  onToggle,
  projectPath,
}: {
  call: TimelineEntry;
  dense?: boolean;
  expanded: boolean;
  divider: boolean;
  onToggle: (id: string) => void;
  projectPath: string;
}) {
  const failed = call.toolStatus === "failed";
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(call.id)}
        className={cn(
          "grid w-full cursor-pointer items-center gap-3 bg-[var(--bg-raised)] px-3 text-left transition-colors hover:bg-[var(--bg-hover)]",
          dense
            ? "h-8 grid-cols-[76px_minmax(0,1fr)_16px]"
            : "h-9 grid-cols-[64px_76px_minmax(0,1fr)_16px]",
          divider && "border-b border-[var(--border-subtle)]",
        )}
      >
        {!dense && (
          <span className="font-mono text-[10.5px] text-[var(--text-ghost)]">{time(call.at)}</span>
        )}
        <span
          className={cn(
            "truncate font-mono text-[11px]",
            failed ? "text-[var(--status-error)]" : "text-[var(--status-info)]",
          )}
        >
          {call.toolName ?? "Other"}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
          {call.paths[0] ?? call.toolTitle ?? ""}
        </span>
        <ChevronRight
          size={12}
          className={cn(
            "text-[var(--border-strong)] transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3">
          {call.paths.length > 0 && (
            <p className="font-mono text-[11px] text-[var(--text-tertiary)]">
              {call.paths.join("  ·  ")}
            </p>
          )}
          {call.arguments && (
            <Pre
              label="Arguments"
              text={call.arguments}
              json
              projectPath={projectPath}
              blobRef={spilledRef(call.argumentsRef, call.arguments)}
            />
          )}
          {call.resultBinary ? (
            <p className="font-mono text-[11px] text-[var(--text-tertiary)]">
              The result is binary and is not shown.
            </p>
          ) : (
            call.result && (
              <Pre
                label="Result"
                text={call.result}
                path={call.paths[0]}
                projectPath={projectPath}
                blobRef={spilledRef(call.resultRef, call.result)}
              />
            )
          )}
          {!call.arguments && !call.result && !call.resultBinary && (
            <p className="font-mono text-[11px] text-[var(--text-ghost)]">
              Nothing else was recorded for this call.
            </p>
          )}
        </div>
      )}
    </div>
  );
});

// ── Checkpoint ──────────────────────────────────────────────────────────────

/**
 * A commit this Session produced — a card, because it is a boundary in the
 * Session rather than another row in it.
 *
 * The file list is the honest limit of what the store holds: Checkpoints carry
 * paths and a diffstat, never the patch. A diff viewer here would need the
 * commit re-read from git, which is a different feature.
 */
function Checkpoint({ entry }: { entry: TimelineEntry }) {
  const orphaned = entry.linkState === "orphaned";
  return (
    <div
      className={cn(
        "mt-2.5 overflow-hidden rounded-md border",
        orphaned
          ? "border-dashed border-[var(--border-strong)]"
          : "border-[var(--border-default)] bg-[var(--bg-raised)]",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
        <GitCommitHorizontal size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-tertiary)]">
          {entry.commitSha?.slice(0, 7)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            orphaned ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
          )}
        >
          {entry.commitSubject ?? (
            // The Checkpoint is a real record even when git can no longer
            // resolve it — a moved repository or a pruned commit must not
            // erase it.
            <span className="text-[var(--text-tertiary)]">
              {orphaned ? "Commit no longer reachable" : "Subject unavailable"}
            </span>
          )}
        </span>
        {/* A squash or a conflict-resolved rebase leaves the subject and the
         *  diffstat intact, so without saying so outright an orphaned
         *  Checkpoint reads exactly like a live one — the "wrong link" this
         *  whole subsystem exists to avoid. */}
        {orphaned && (
          <span
            className="shrink-0 rounded-full bg-[var(--status-warning-muted)] px-2 py-px font-mono text-[10px] text-[var(--status-warning)]"
            title="This commit is no longer in history — rewritten or squashed. The Session record is kept."
          >
            orphaned
          </span>
        )}
        {entry.insertions > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--stat-added)]">
            +{entry.insertions}
          </span>
        )}
        {entry.deletions > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--stat-removed)]">
            −{entry.deletions}
          </span>
        )}
      </div>

      {entry.files.length > 0 && (
        <ul className="px-3 py-2">
          {entry.files.slice(0, 12).map((file) => (
            <li
              key={file}
              className="truncate font-mono text-[11px] leading-[1.75] text-[var(--text-tertiary)]"
            >
              {file}
            </li>
          ))}
          {entry.files.length > 12 && (
            <li className="font-mono text-[11px] leading-[1.75] text-[var(--text-ghost)]">
              +{entry.files.length - 12} more
            </li>
          )}
        </ul>
      )}

      {/* Suppressed when orphaned: the branch no longer contains this commit,
       *  so showing it would assert exactly the link that was lost. */}
      {entry.branch && !orphaned && (
        <p className="border-t border-[var(--border-subtle)] px-3 py-1.5 font-mono text-[10.5px] text-[var(--text-ghost)]">
          {entry.branch}
        </p>
      )}
    </div>
  );
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * The filter drawer.
 *
 * A drawer rather than a permanent rail: filtering is something you do
 * occasionally, and a 340px column present at all times took a quarter of the
 * reading measure to say "everything is shown".
 */
function FilterDrawer({
  detail,
  filters,
  setFilters,
  failedOnly,
  setFailedOnly,
  failedCount,
  tools,
  setTools,
  expandTools,
  setExpandTools,
  foldResponses,
  setFoldResponses,
  activeFilters,
  checkpoints,
  onJump,
  onClose,
}: {
  detail: Detail;
  filters: TimelineFilters;
  setFilters: (fn: (current: TimelineFilters) => TimelineFilters) => void;
  failedOnly: boolean;
  setFailedOnly: (v: boolean) => void;
  failedCount: number;
  tools: Set<string>;
  setTools: (fn: (current: Set<string>) => Set<string>) => void;
  expandTools: boolean;
  setExpandTools: (v: boolean) => void;
  foldResponses: boolean;
  setFoldResponses: (v: boolean) => void;
  activeFilters: number;
  /** Every Checkpoint in the Session, in timeline order. */
  checkpoints: TimelineEntry[];
  onJump: (entryId: string) => void;
  onClose: () => void;
}) {
  // Escape closes it, like every other overlay in Atlas. Bound to the window
  // rather than to the drawer so it works wherever focus happens to be — this
  // is not a focus trap, and the reader may still be scrolling the timeline
  // behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const s = detail.summary;
  const kinds: Array<[keyof TimelineFilters, string, number]> = [
    ["prompts", "Prompts", detail.counts.prompts],
    ["responses", "Responses", detail.counts.responses],
    ["thinking", "Thinking", detail.counts.thinking],
    ["toolCalls", "Tool calls", detail.counts.toolCalls],
    ["checkpoints", "Checkpoints", detail.counts.checkpoints],
  ];

  return (
    <>
      {/* Scrim — subtle; the blurred panel carries the depth, as in the
       *  notification centre. Clicking it dismisses. */}
      <div
        className="animate-fade-in absolute inset-0 z-40 bg-black/10"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Filters"
        className="animate-slide-in-right absolute bottom-0 right-0 top-0 z-50 flex w-[340px] flex-col border-l border-[var(--border-default)] bg-[var(--bg-elevated)]/60 shadow-[var(--shadow-overlay)] backdrop-blur-2xl"
      >
        {/* No header row at all. With no active filters it was an empty strip
         *  holding one X — the close button floats over the content instead,
         *  and the "N active · Reset" affordance rides as the content's first
         *  row only when there is something to reset. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          className="absolute right-2 top-2 z-10 flex size-6 cursor-pointer items-center justify-center rounded text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>

        <div className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-8 pt-4">
          {activeFilters > 0 && (
            <div className="flex items-center gap-2 pr-8">
              <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                {activeFilters} active
              </span>
              <button
                type="button"
                onClick={() => {
                  setFilters(() => DEFAULT_FILTERS);
                  setFailedOnly(false);
                  setTools(() => new Set());
                }}
                className="h-[22px] cursor-pointer rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
              >
                Reset
              </button>
            </div>
          )}
          {checkpoints.length > 0 && (
            <Section label="Checkpoints" hint={`${checkpoints.length} commits`}>
              <CheckpointJump checkpoints={checkpoints} onJump={onJump} />
            </Section>
          )}

          <Section label="Event types" hint={`${detail.entries.length} events`}>
            {kinds.map(([key, label, count]) => (
              <FilterChip
                key={key}
                label={label}
                count={count}
                on={filters[key]}
                enabled={count > 0}
                onClick={() => setFilters((c) => ({ ...c, [key]: !c[key] }))}
              />
            ))}
          </Section>

          {detail.tools.length > 0 && (
            <Section label="Tool" hint={`${s.toolCallCount} calls`}>
              {detail.tools.map((tally) => (
                <FilterChip
                  key={tally.toolName}
                  label={tally.toolName}
                  count={tally.count}
                  on={tools.has(tally.toolName)}
                  enabled
                  onClick={() =>
                    setTools((current) => {
                      const next = new Set(current);
                      if (next.has(tally.toolName)) next.delete(tally.toolName);
                      else next.add(tally.toolName);
                      return next;
                    })
                  }
                />
              ))}
            </Section>
          )}

          {/* A display preference, not a filter — it hides nothing, so it is not
           *  counted in the active-filter badge and Reset leaves it alone. */}
          <Section label="View">
            <FilterChip
              label="Expand tool calls"
              count={detail.counts.toolCalls}
              on={expandTools}
              enabled={detail.counts.toolCalls > 0}
              onClick={() => setExpandTools(!expandTools)}
            />
            <FilterChip
              label="Final response only"
              count={detail.counts.responses}
              on={foldResponses}
              enabled={detail.counts.responses > 1}
              onClick={() => setFoldResponses(!foldResponses)}
            />
          </Section>

          <Section label="Outcome">
            <FilterChip
              label="Failed only"
              count={failedCount}
              on={failedOnly}
              enabled={failedCount > 0}
              dot="var(--status-error)"
              onClick={() => setFailedOnly(!failedOnly)}
            />
          </Section>

          <div className="border-t border-dashed border-[var(--border-subtle)] pt-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
              Session
            </p>
            <dl className="mt-2.5 flex flex-col gap-2">
              <Meta label="Model" value={prettyModel(s.model) ?? "—"} />
              <Meta label="Agent" value={s.agent ? agentLabel(s.agent) : "—"} />
              <Meta label="Branch" value={s.branches[0] ?? "—"} />
              <Meta label="Started" value={new Date(s.startedAt).toLocaleString()} />
              <Meta label="Messages" value={String(s.messageCount)} />
              <Meta
                label="Changes"
                value={
                  s.insertions || s.deletions
                    ? `+${s.insertions} / −${s.deletions} in ${s.filesTouched} file${s.filesTouched === 1 ? "" : "s"}`
                    : "—"
                }
              />
              <Meta label="Session id" value={s.id.slice(-8)} />
            </dl>

            {s.source === "external_jsonl" && (
              <p className="mt-4 rounded-md border border-dashed border-[var(--border-default)] px-3 py-2.5 text-[11.5px] leading-[1.55] text-[var(--text-tertiary)]">
                Imported session — read from a transcript on disk. Commits aren&apos;t linked to
                imported history, and token usage wasn&apos;t recorded.
              </p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * Jump straight to any commit this Session produced.
 *
 * A searchable combo rather than a plain list: a long Session can produce a
 * dozen Checkpoints, and by the time you are looking for one you usually know a
 * word from its subject. Searching a subject beats scrolling a list of shas.
 *
 * The trigger keeps saying "Jump to" rather than showing the last selection —
 * this is a *verb*, not a setting. Nothing here is part of the filter state,
 * which is why Reset leaves it alone.
 */
function CheckpointJump({
  checkpoints,
  onJump,
}: {
  checkpoints: TimelineEntry[];
  onJump: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return checkpoints;
    return checkpoints.filter(
      (c) =>
        c.commitSubject?.toLowerCase().includes(needle) ||
        c.commitSha?.toLowerCase().includes(needle) ||
        c.branch?.toLowerCase().includes(needle),
    );
  }, [checkpoints, query]);

  /** Position in the FULL list — `#3` must mean the third Checkpoint of the
   *  Session even when the search has narrowed what's shown. (Also drops the
   *  `indexOf` inside the render map, which was quadratic.) */
  const ordinal = useMemo(() => new Map(checkpoints.map((c, i) => [c.id, i + 1])), [checkpoints]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          <span className="flex-1">Jump to</span>
          <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[var(--z-max)] flex max-h-[320px] w-[var(--radix-popover-trigger-width)] origin-[var(--radix-popover-content-transform-origin)] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)]/95 shadow-[var(--shadow-overlay)] backdrop-blur-2xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          {/* The search only appears when there is enough to search. */}
          {checkpoints.length > 4 && (
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2.5">
              <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a commit…"
                spellCheck={false}
                autoFocus
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          )}

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-1">
            {matches.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11.5px] text-[var(--text-tertiary)]">
                No match.
              </p>
            ) : (
              matches.map((checkpoint, i) => {
                const sha = checkpoint.commitSha ?? "";
                const changed = checkpoint.insertions + checkpoint.deletions;
                return (
                  <button
                    key={checkpoint.id}
                    type="button"
                    onClick={() => {
                      onJump(checkpoint.id);
                      setOpen(false);
                    }}
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <span className="truncate text-[12.5px] text-[var(--text-secondary)]">
                      {checkpoint.commitSubject ?? (
                        <span className="text-[var(--text-tertiary)]">Subject unavailable</span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--text-ghost)]">
                      <span>
                        #{ordinal.get(checkpoint.id) ?? i + 1} · {sha.slice(0, 7)}
                      </span>
                      {changed > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--stat-added)]">+{checkpoint.insertions}</span>
                          <span className="text-[var(--stat-removed)]">
                            −{checkpoint.deletions}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {label}
        </span>
        {hint && <span className="font-mono text-[10px] text-[var(--text-ghost)]">{hint}</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  on,
  enabled,
  dot,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  enabled: boolean;
  dot?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className={cn(
        "flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
        !enabled
          ? "cursor-default border-[var(--border-subtle)] text-[var(--text-ghost)]"
          : on
            ? "cursor-pointer border-[var(--border-strong)] bg-[var(--bg-active)] text-[var(--text-primary)]"
            : "cursor-pointer border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      {dot && enabled && (
        <span className="size-[5px] rounded-full" style={{ backgroundColor: dot }} />
      )}
      {label}
      <span className="font-mono text-[10px] text-[var(--text-ghost)]">{count}</span>
    </button>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[12px] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

// ── Content primitives ──────────────────────────────────────────────────────

/**
 * One control in the action bar.
 *
 * `bare` drops the border and background: inside the right-hand pill the group
 * carries those, and a bordered button inside a bordered pill reads as a
 * double outline at this scale.
 */
function BarButton({
  label,
  active,
  badge,
  bare,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  bare?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pointer-events-auto relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        disabled
          ? "cursor-default text-[var(--text-ghost)]"
          : "cursor-pointer text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
        !bare &&
          "border border-[var(--border-default)] bg-[var(--bg-elevated)]/70 backdrop-blur-xl",
        !bare && "shadow-[var(--shadow-overlay)]",
        active && !bare && "border-[var(--border-strong)] text-[var(--text-primary)]",
      )}
    >
      {children}
      {badge !== undefined && (
        <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-[var(--accent-primary)] font-mono text-[8px] font-semibold text-[var(--bg-base)]">
          {badge}
        </span>
      )}
    </button>
  );
}

function TabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-[12.5px] font-medium tracking-[-0.01em] transition-colors",
        active
          ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
          : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
      )}
    >
      {children}
      <span className="font-mono text-[10px] text-[var(--text-ghost)]">{count}</span>
    </button>
  );
}

/** Height past which a body collapses behind a "Show more". */
const CLAMP_MAX_PX = 340;
/** Slack — a body barely over the limit is not worth a control. */
const CLAMP_SLACK_PX = 60;

function Clamp({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Still observed rather than read once at mount — a body that arrives late
  // (a spilled payload fetched by `Show full`, markdown resolving off the
  // worker) changes height after the first measurement, and a one-shot read
  // would leave the clamp control missing on exactly the longest bodies.
  //
  // But through the *shared* observer: one instance for the whole timeline
  // rather than one per row. This measured 1098 constructions in a single
  // browsing session, all asking the same question.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeSize(el, (entry) => {
      const height = (entry.target as HTMLElement).scrollHeight;
      // Zero means "not laid out yet", not "empty" — committing that would flip
      // an already-open clamp shut.
      if (height === 0) return;
      setOverflows(height > CLAMP_MAX_PX + CLAMP_SLACK_PX);
    });
  }, []);

  return (
    <div className="relative">
      <div
        ref={ref}
        className="overflow-hidden"
        style={{ maxHeight: expanded || !overflows ? undefined : CLAMP_MAX_PX }}
      >
        {children}
      </div>
      {overflows && !expanded && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
          style={{
            background: "linear-gradient(to bottom, transparent, var(--bg-surface))",
          }}
        />
      )}
      {/* Centred and *on* the fade rather than below it. A bare text link under
       *  a gradient sits at whatever contrast the gradient leaves it — which,
       *  over a mono block, was none. The pill brings its own background. */}
      {overflows && (
        <div
          className={cn(
            "flex justify-center",
            expanded ? "mt-2" : "absolute inset-x-0 bottom-0 translate-y-1/2",
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 text-[11.5px] text-[var(--text-secondary)] shadow-[var(--shadow-overlay)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown
              size={12}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A prompt, with what Atlas contributed to it shown rather than hidden.
 *
 * Atlas injects its own memory into the wire prompt — shared cross-agent
 * memory, retrieved project memory, a recent-session recap — and the agent
 * echoes the whole thing back into its transcript. The chat renderer strips
 * those blocks because there they are scaffolding around something the person
 * typed. Here they are the opposite: the record of what Atlas *knew* going into
 * the turn, which is the one thing a Session transcript can say that a raw
 * agent log cannot. Same parser as the strip, so the two cannot disagree about
 * where a block ends.
 */
function Prompt({ entry, projectPath }: { entry: TimelineEntry; projectPath: string }) {
  const split = useMemo(() => extractInjectedContext(entry.text ?? ""), [entry.text]);

  // Nothing injected: the common case, and it must stay exactly as cheap as it
  // was — one block, no wrapper.
  if (split.blocks.length === 0) {
    return (
      <Clamp>
        <Block text={entry.text ?? ""} entry={entry} projectPath={projectPath} />
      </Clamp>
    );
  }

  return (
    <>
      {split.prose && (
        <Clamp>
          <Block text={split.prose} entry={entry} projectPath={projectPath} />
        </Clamp>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {split.blocks.map((block, i) => (
          <MemoryBlock key={`${block.label}-${i}`} block={block} />
        ))}
      </div>
    </>
  );
}

/** How each injected label reads once it is a heading rather than a marker. */
const MEMORY_LABELS: Record<string, string> = {
  "SHARED MEMORY": "Shared memory",
  "RELEVANT PROJECT MEMORY": "Project memory",
  "PROJECT MEMORY": "Project memory",
  "RECENT SESSION": "Recent sessions",
};

/**
 * One block of Atlas-supplied context, under the Atlas mark.
 *
 * Folded by default and small: it is provenance, not the conversation. The mark
 * is the point — it says *Atlas* put this in front of the agent, which is
 * otherwise invisible in a transcript that reads as if the agent knew it all
 * along.
 */
function MemoryBlock({ block }: { block: InjectedBlock }) {
  const [open, setOpen] = useState(false);
  const lines = block.body ? block.body.split("\n").length : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-raised)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
      >
        <AtlasIcon size={12} className="shrink-0 rounded-[2px]" />
        <span className="text-[12px] text-[var(--text-secondary)]">
          {MEMORY_LABELS[block.label] ?? block.label.toLowerCase()}
        </span>
        <span className="font-mono text-[10.5px] text-[var(--text-ghost)]">from Atlas memory</span>
        <span className="flex-1" />
        {lines > 0 && (
          <span className="font-mono text-[10.5px] text-[var(--text-ghost)]">
            {lines} line{lines === 1 ? "" : "s"}
          </span>
        )}
        <ChevronRight
          size={12}
          className={cn("text-[var(--border-strong)] transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="hide-scrollbar max-h-[320px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--border-subtle)] px-3.5 py-2.5 font-mono text-[11px] leading-[1.7] text-[var(--text-tertiary)]">
          {block.body || "(empty)"}
        </div>
      )}
    </div>
  );
}

/** A prompt or any verbatim payload: mono, boxed, never re-interpreted. */
function Block({
  text,
  entry,
  projectPath,
}: {
  text: string;
  entry: TimelineEntry;
  projectPath: string;
}) {
  return (
    <div className="mt-2.5 whitespace-pre-wrap break-words rounded-md border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3.5 py-3 font-mono text-[11.5px] leading-[1.75] text-[var(--text-secondary)]">
      <Body entry={entry} projectPath={projectPath} raw={text} />
    </div>
  );
}

function Pre({
  label,
  text,
  path,
  json,
  projectPath,
  blobRef,
}: {
  label: string;
  text: string;
  path?: string | null;
  /** Force JSON: arguments are always an object, whatever they look like. */
  json?: boolean;
  projectPath: string;
  blobRef: string | null;
}) {
  const [full, setFull] = useState<string | null>(null);
  const source = full ?? text;
  const pretty = json ? prettyJson(source) : { text: source, json: false };
  return (
    <div>
      <CodeBlock
        text={pretty.text}
        path={path}
        label={label}
        language={pretty.json ? "JSON" : undefined}
      />
      {blobRef && full === null && (
        <ShowFull projectPath={projectPath} blobRef={blobRef} onLoaded={setFull} />
      )}
    </div>
  );
}

/**
 * Is this entry's payload actually spilled, or already inlined in full?
 *
 * A spilled-but-small payload is already inlined whole, so the ref alone is not
 * enough — a full inline is ~64 KB where a preview is ~2 KB.
 */
function spilledRef(ref: string | null, inline: string | null): string | null {
  if (!ref) return null;
  return (inline?.length ?? 0) <= 4096 ? ref : null;
}

/** Message text, with the truncation stated rather than hidden. */
function Body({
  entry,
  projectPath,
  markdown = false,
  raw,
}: {
  entry: TimelineEntry;
  projectPath: string;
  /** Render through the cached markdown pipeline (responses only — prompts are
   *  verbatim developer input and must not be reinterpreted). */
  markdown?: boolean;
  /** Pre-resolved text, when the caller already has it. */
  raw?: string;
}) {
  const [full, setFull] = useState<string | null>(null);
  const truncated = entry.truncated && full === null;

  const notice = truncated && (
    <>
      <span className="ml-1 text-[11px] text-[var(--text-tertiary)]">
        … {compact(entry.bodyBytes)} bytes not shown
      </span>
      {entry.bodyRef && (
        <ShowFull projectPath={projectPath} blobRef={entry.bodyRef} onLoaded={setFull} />
      )}
    </>
  );

  if (markdown) {
    return (
      <div className="break-words">
        <CachedMarkdown source={full ?? entry.text ?? ""} />
        {truncated && <p className="-ml-1 mt-1">{notice}</p>}
      </div>
    );
  }

  return (
    <>
      {full ?? raw ?? entry.text}
      {notice}
    </>
  );
}

/**
 * Fetch a spilled payload on demand.
 *
 * The failure copy matters: a pruned blob store is a real state (the Session
 * still renders from previews) and "could not load" must not read as a crash.
 */
function ShowFull({
  projectPath,
  blobRef,
  onLoaded,
}: {
  projectPath: string;
  blobRef: string;
  onLoaded: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFull = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await invoke<ArtifactPayload>("artifacts_payload", {
        projectPath,
        blobRef,
      });
      if (payload.text !== null) onLoaded(payload.text);
      else setError("The full payload is binary and cannot be shown.");
    } catch {
      setError("The full payload is no longer on disk.");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <span className="ml-1.5 text-[11px] text-[var(--text-tertiary)]">{error}</span>;
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void fetchFull()}
      className="ml-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:no-underline hover:text-[var(--text-primary)] disabled:opacity-60"
    >
      {busy && <Loader2 size={10} className="animate-spin" />}
      Show full
    </button>
  );
}

function Empty({
  detail,
  failedOnly,
  failedCount,
}: {
  detail: Detail;
  failedOnly: boolean;
  failedCount: number;
}) {
  return (
    <p className="py-16 text-center text-[12px] text-[var(--text-tertiary)]">
      {detail.entries.length === 0
        ? "Nothing was recorded in this session."
        : failedOnly && failedCount === 0
          ? "No tool calls failed in this session."
          : "Every entry is hidden by the current filters."}
    </p>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function passes(
  entry: TimelineEntry,
  filters: TimelineFilters,
  failedOnly: boolean,
  tools: Set<string>,
): boolean {
  switch (entry.kind) {
    case "prompt":
      return filters.prompts;
    case "response":
      return filters.responses;
    case "thinking":
      return filters.thinking;
    case "checkpoint":
      return filters.checkpoints;
    case "tool_call":
      if (!filters.toolCalls) return false;
      if (failedOnly && entry.toolStatus !== "failed") return false;
      if (tools.size > 0 && !tools.has(entry.toolName ?? "Other")) return false;
      return true;
  }
}

/**
 * Free-text search over one entry.
 *
 * The haystack — every searchable field lowercased and joined — is built ONCE
 * per entry and cached in a WeakMap. Building it per keystroke was the cost
 * that made search feel heavy: `arguments` and `result` previews run to 64 KB,
 * a Session runs to hundreds of entries, and `toLowerCase()` over all of it
 * allocated megabytes of transient strings for every character typed. The
 * entry-sharing pass above is what makes the WeakMap effective across live
 * polls: a reused entry object keeps its haystack.
 *
 * Fields are joined with `\n`, which a single-line search input can never
 * contain, so a needle cannot falsely match across a field boundary. Payloads
 * are searched too — a stack trace is exactly the thing someone comes back to
 * a Session to find — but a truncated entry can only match on its preview,
 * which is stated on the row rather than silently missed.
 */
const haystacks = new WeakMap<TimelineEntry, string>();

function haystack(entry: TimelineEntry): string {
  let built = haystacks.get(entry);
  if (built === undefined) {
    built = [
      entry.text,
      entry.toolName,
      entry.toolTitle,
      entry.commitSubject,
      entry.commitSha,
      entry.branch,
      entry.arguments,
      entry.result,
      ...entry.paths,
      ...entry.files,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    haystacks.set(entry, built);
  }
  return built;
}

function matches(entry: TimelineEntry, needle: string): boolean {
  if (!needle) return true;
  return haystack(entry).includes(needle);
}

/**
 * `18:29 → 19:27 · 2h 14m span`, under the active-time metric.
 *
 * Both numbers, because they answer different questions: the metric is agent
 * time and this is the wall-clock span it happened inside. Showing only one
 * invites reading it as the other.
 */
function clock(s: Detail["summary"]): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(s.startedAt)} → ${fmt(s.lastActivityAt)} · ${formatDuration(s.wallSeconds)} span`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
