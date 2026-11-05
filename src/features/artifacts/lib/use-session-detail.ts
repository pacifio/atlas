import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DEFAULT_FILTERS,
  type SessionDetail as Detail,
  type TimelineEntry,
  type TimelineFilters,
} from "../types";
import { JUMP_EVENT, type JumpDetail } from "../components/session-chat-message";
import { filterKeyForKind } from "./comment-threads";
import { animatedScrollTo } from "./scroll-to";
import { createFocusStore } from "./session-detail-context";
import { foldRuns, groupEntries, matches, passes, type Group } from "./session-timeline";
import { useTimelineScroll } from "./use-timeline-scroll";

/**
 * How many visible entries render before the window has to grow.
 *
 * Small on purpose. A Session runs to hundreds of entries and each one may carry
 * markdown, a highlighted payload, or a call table — 300 of those is a second of
 * blocked main thread before anything appears, to fill a viewport that holds
 * about eight. The rest arrive on scroll, well ahead of the fold.
 */
const WINDOW_CHUNK = 40;

/**
 * How many groups the FIRST paint of a Session renders.
 *
 * A viewport holds about eight, and the click that opened the Session waits on
 * every one rendered before it paints — forty of them was most of a 200ms
 * open. The rest follow straight after without blocking: the scroll loop sees
 * the bottom inside its grow margin and tops the window up to a full chunk as
 * a transition.
 */
const FIRST_PAINT = 12;

/**
 * How many groups one step of a jump's window growth mounts.
 *
 * A jump to a thread near the end of a long Session has to mount every row
 * above it — seven hundred, on a busy one. In one update that was a single
 * second-long task: the comments popup froze half-closed on the first frames
 * and nothing moved until the whole lot was laid out. In steps of this size,
 * each rendered as a transition (so React yields while it builds them), no one
 * frame carries more than a step's worth of style and layout.
 */
const JUMP_STEP = 120;

/**
 * Everything the Session reader holds: the filters, the render window, and the
 * jump machinery that settles a request over renders. The pane
 * (`SessionDetail`) calls this once and lays out what it returns.
 */
export function useSessionDetail({
  detail,
  entriesStreaming,
  focusCommitSha,
  focusAnchor,
}: {
  detail: Detail;
  entriesStreaming: boolean;
  focusCommitSha?: string;
  focusAnchor?: { kind: string; id: string };
}) {
  const [filters, setFilters] = useState<TimelineFilters>(DEFAULT_FILTERS);
  /** Narrow tool calls to failed ones — the "which calls failed" question. */
  const [failedOnly, setFailedOnly] = useState(false);
  /** Which canonical tool names are selected. Empty means all. */
  const [tools, setTools] = useState<Set<string>>(new Set());
  /** Keep every tool-call group open. Off by default — see `Calls`. */
  const [expandTools, setExpandTools] = useState(false);
  /** Show every response, or only the last of each consecutive run. */
  const [foldResponses, setFoldResponses] = useState(false);
  /** Free-text narrowing of the timeline. */
  const [search, setSearch] = useState("");
  const [renderCount, setRenderCount] = useState(FIRST_PAINT);
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
  /** Which entry's comment thread to open, from the comments panel. The
   *  counter is what lets the same thread be asked for twice. */
  const [focusStore] = useState(createFocusStore);
  const setFocusThread = focusStore.set;
  const contentRef = useRef<HTMLDivElement | null>(null);

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

  const { more, onScroll, invalidate } = useTimelineScroll({
    scrollRef,
    contentRef,
    anchorRefs,
    anchorCount: anchors.length,
    canGrow: renderCount < groups.length,
    // A transition, so mounting the next chunk yields to the scroll that asked
    // for it instead of stalling it mid-fling.
    onGrow: useCallback(
      () =>
        startTransition(() =>
          setRenderCount((count) => Math.min(count + WINDOW_CHUNK, groups.length)),
        ),
      [groups.length],
    ),
  });

  // A new Session or a filter change restarts the window from the top.
  // Keyed to the DEFERRED search so the reset lands with the results it belongs
  // to — resetting on the raw keystroke scrolled to top a beat before the list
  // changed.
  useEffect(() => {
    setRenderCount(FIRST_PAINT);
    scrollRef.current?.scrollTo({ top: 0 });
    // The list was swapped wholesale; a same-height replacement would not trip
    // the ResizeObserver and every cached offset would describe the old rows.
    invalidate();
  }, [detail.summary.id, filters, failedOnly, tools, deferredSearch, foldResponses, invalidate]);

  // …and straight after that first paint, top the window up to a full chunk
  // without blocking (see `FIRST_PAINT`). Not left to the scroll loop alone:
  // twelve long rows can already overrun its grow margin, and then nothing
  // past them would mount until the reader scrolled — a fling would hit the
  // end of the window.
  useEffect(() => {
    if (renderCount >= WINDOW_CHUNK || renderCount >= groups.length) return;
    startTransition(() =>
      setRenderCount((count) => Math.max(count, Math.min(WINDOW_CHUNK, groups.length))),
    );
  }, [renderCount, groups.length]);

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
      // Reveal whatever kind the TARGET is, not Checkpoints.
      //
      // This used to unconditionally enable `checkpoints`, which worked only
      // because the sole jump sources were Checkpoints and chat citations. The
      // comments panel can address any node, and `thinking` is off by default —
      // so a comment on a thinking entry set `pendingJump`, found no index,
      // wrote the same filter state back, and stalled silently with no retry
      // and no error. A dead click, permanently.
      const target = detail.entries.find((e) => e.id === pendingJump);
      if (!target) {
        // Not arrived yet, on a Session still streaming in: hold the request.
        // This effect re-runs as each page lands (`groups` moves), and the
        // jump goes through once its entry is here.
        if (entriesStreaming) return;
        setPendingJump(null);
        return;
      }
      const key = filterKeyForKind(target.kind);
      // The narrowing filters hide entries too, and clearing them is the only
      // way a jump into a filtered-out tool call or a searched-away row lands.
      setFailedOnly(false);
      setTools((current) => (current.size === 0 ? current : new Set()));
      setSearch("");
      // `foldRuns` drops all but the last of a consecutive response run, so a
      // comment on a folded-away response is missing from `groups` even with
      // every filter on. Clearing all five is what guarantees this effect
      // terminates instead of re-running against an unchanged state.
      setFoldResponses(false);
      setFilters((current) => (current[key] ? current : { ...current, [key]: true }));
      return;
    }
    if (index >= renderCount) {
      // Stepped and as a transition — see `JUMP_STEP`. Each commit re-runs
      // this effect (`renderCount` is a dependency), which takes the next
      // step until the target is mounted.
      const next = Math.min(index + 40, renderCount + JUMP_STEP);
      startTransition(() => setRenderCount(next));
      return;
    }
    // Only a group's HEAD is registered — a run of tool calls is one row on
    // the rail — so the scroll target is that head, never the entry itself. A
    // comment on the fourth call of a run used to look up its own id here,
    // find nothing, and leave `pendingJump` set: a click that did nothing, for
    // good.
    const node = entryRefs.current.get(groups[index].entries[0].id);
    if (node) {
      jumpTo(node, "center");
      // A smooth scroll into the middle of a long conversation leaves no clue
      // which row was the destination. The ring says "this one", then gets out
      // of the way.
      setLanded(pendingJump);
      setPendingJump(null);
    }
  }, [pendingJump, groups, renderCount, jumpTo, entriesStreaming]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => {
      setLanded(null);
      // The jump has settled and the thread it was for is open, so the request
      // is spent. Clearing it matters because the render window restarts from
      // the top whenever the filters or the Session change, re-mounting every
      // row — and a `focusThread` still set would pop a thread open on the way
      // past, long after the click that asked for it.
      setFocusThread(null);
    }, 2000);
    return () => clearTimeout(timer);
  }, [landed]);

  // A request that never settled — its entry is not in this record at all —
  // must not outlive the Session it was made on.
  useEffect(() => {
    setFocusThread(null);
  }, [detail.summary.id]);

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
      setPendingJump(target.id);
    }
  }, [focusCommitSha, detail.summary.id, detail.entries]);

  /**
   * Scroll to the entry AND open the thread hanging off it. Landing beside a
   * remark without showing it makes you hunt for the thing you just clicked.
   *
   * `setPendingJump` rather than `jumpToAnchor`: the settling effect above is
   * what reveals a kind the filters are hiding, grows the render window and
   * unfolds a run of tool calls — so a remark on the fourth call of a run
   * arrives with its own button mounted to hang the popover off. `jumpToAnchor`
   * only scrolls, and would have opened nothing in every one of those cases.
   *
   * Stable, so the memoised `CommentsMorph` is not rebuilt on every render of
   * this pane.
   */
  const sessionId = detail.summary.id;
  const jumpToThread = useCallback(
    (anchorId: string) => {
      setFocusThread((prev) => ({ anchorId, n: (prev?.n ?? 0) + 1 }));
      // The whole-Session thread hangs off the masthead, which is no entry and
      // is already at the top.
      if (anchorId === sessionId) {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setPendingJump(anchorId);
    },
    [sessionId, setFocusThread],
  );

  // Arrived from the inbox. Honoured once per arrival, and only once the
  // anchored row is here — a Session read from the server streams in, and a
  // jump to a row still on its way would find nothing.
  const honouredAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusAnchor) return;
    const arrival = `${detail.summary.id}:${focusAnchor.kind}:${focusAnchor.id}`;
    if (honouredAnchor.current === arrival) return;
    if (focusAnchor.kind === "session") {
      honouredAnchor.current = arrival;
      jumpToThread(sessionId);
      return;
    }
    if (detail.entries.some((entry) => entry.id === focusAnchor.id)) {
      honouredAnchor.current = arrival;
      jumpToThread(focusAnchor.id);
    }
  }, [focusAnchor, detail.summary.id, detail.entries, jumpToThread, sessionId]);

  const activeFilters =
    (filters.prompts ? 0 : 1) +
    (filters.responses ? 0 : 1) +
    (filters.thinking ? 1 : 0) +
    (filters.toolCalls ? 0 : 1) +
    (filters.checkpoints ? 0 : 1) +
    (failedOnly ? 1 : 0) +
    tools.size +
    (search.trim() ? 1 : 0);

  /**
   * Where the reader is among the Checkpoints, for the filter menu's
   * previous / next: the index of the one at the middle of the viewport, or
   * the half-step between the two either side of it (`1.5` = between the
   * second and the third). Read from the rows on screen when asked, never
   * tracked per scroll.
   *
   * A Checkpoint with no row is one the render window has not reached yet —
   * below everything on screen — or one a filter hides, which a jump reveals.
   */
  const currentCheckpoint = useCallback((): number => {
    const scroller = scrollRef.current;
    if (!scroller) return -0.5;
    const view = scroller.getBoundingClientRect();
    const middle = view.top + view.height / 2;
    let before = -1;
    for (let i = 0; i < checkpoints.length; i += 1) {
      const node = entryRefs.current.get(checkpoints[i].id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      // A jump centres its target, so "at the middle" is within a row's
      // height of it.
      if (rect.top <= middle && rect.bottom >= middle - 8) return i;
      if (rect.bottom < middle) before = i;
      else break;
    }
    return before + 0.5;
  }, [checkpoints]);

  return {
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
  };
}
