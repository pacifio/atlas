import {
  createContext,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useContext,
  useState,
  startTransition,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Popover } from "@base-ui/react/popover";
import { invoke } from "@tauri-apps/api/core";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  MessageSquare,
  Download,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  Search,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  User,
} from "lucide-react";

import { AtlasIcon } from "@/components/atlas-icon";
import { ActionCluster } from "./action-cluster";
import { extractInjectedContext, type InjectedBlock } from "@/features/chat/lib/atlas-context";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { fmtCost } from "@/features/monitor/lib/usage-format";
import { timeAgo } from "@/lib/time-ago";
import {
  costOf,
  priceForModel,
  useModelPricingStore,
  type TokenSpend,
} from "@/features/settings/stores/model-pricing-store";
import { cn } from "@/lib/utils";
import { ContextMeter } from "./context-meter";
import { CommentsMorph } from "./comments-morph";
import { ShareMorph } from "./share-morph";
import { ExportButton } from "./export-button";
import { FooterPill, PILL_BUTTON, PILL_BUTTON_ACTIVE, PILL_ICON } from "./footer-pill";
import { HintItem } from "@/ui/hint-group";
import { GlassIconButton } from "@/features/sidebar/components/glass-icon-button";
import { ScrollFade, useScrollEdges } from "@/ui/scroll-fade";
import { EMPTY_DIRECTORY } from "../lib/author-directory";

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
  sessionState,
  sessionTitle,
  tokenBreakdown,
  tokenLabel,
} from "../lib/board";
import { observeSize } from "../lib/shared-resize-observer";
import { animatedScrollTo } from "../lib/scroll-to";
import { useTimelineScroll } from "../lib/use-timeline-scroll";
import { commentActivity } from "../lib/comment-activity";
import { toolLine } from "../lib/tool-line";
import { ToolGlyph } from "@/features/chat/components/tool-glyph";
import { anchorKindFor, visibleCount, type Comment } from "../lib/comments-api";
import { CodeBlock, CopyButton, prettyJson } from "./code-block";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { avatarUser, CommentButton, type CommentActions } from "./comment-thread";
import { filterKeyForKind } from "../lib/comment-threads";
import { JUMP_EVENT, type JumpDetail } from "./session-chat-message";
import { AgentGlyph } from "./agent-glyph";
import { formatTime } from "@/lib/format-time";
import { CheckpointFindings } from "@/features/security/components/checkpoint-findings";
import { SecuritySummary } from "@/features/security/components/security-summary";
import {
  ShipOverviewCard,
  useBranchPullRequest,
} from "@/features/security/components/ship-overview-card";

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

/** Half the tallest rail node — where the hairline starts and stops. */
const NODE_CENTRE = 16;

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

/**
 * Everything the comment surfaces need, or `null` on a Session that is not
 * shared with an Organisation.
 *
 * One object rather than five props, because it is all-or-nothing: without a
 * cloud Project there is no anchor to attach a comment to, so every part of it
 * is absent together.
 */
export interface RowComments {
  /** Entry `rowId` → its thread. The id is the local one, pushed verbatim. */
  byAnchor: Record<string, Comment[]>;
  /** Comments on the Session itself, shown from the masthead. */
  session: Comment[];
  actions: CommentActions;
  /**
   * The Organisation's roster, for names and faces.
   *
   * Passed down rather than looked up per comment: one hook at the pane, and
   * every byline, mention and avatar stack below resolves against the same map.
   * It also carries `currentUserId`, which is what decides whose comments get a
   * delete affordance.
   */
  directory: OrgDirectory;
}

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
  /** Whether the grounded chat is open beside the record. The panel is the
   *  pane's; the button that opens it is in this footer. */
  chatOpen?: boolean;
  /** Open or close it. Absent, the footer has no Ask button. */
  onToggleChat?: () => void;
}

/**
 * Where an oversized payload comes from, when it is not on this disk.
 *
 * A **context** rather than another prop because the components that expand a
 * payload — a response body, a tool call's arguments, its result — sit three
 * and four levels below the pane, behind `Calls` and `CallTable` and `CallRow`,
 * none of which have any other reason to know about it. Threading it would put
 * a prop nobody reads through every one of them.
 */
export interface RemoteSource {
  /** The server Project id. */
  projectId: string;
  sessionId: string;
}

const RemoteSourceContext = createContext<RemoteSource | null>(null);

/**
 * Which entry's comment thread the all-comments panel has asked to open.
 *
 * A counter rather than a flag, so the same thread can be asked for twice —
 * close the popover, click the same row again, and `n` moves even though
 * `anchorId` did not. It travels by context because the rows that need it are
 * memoised components several levels down (`Row`, `CallRow`); threading a prop
 * through every level would re-render the whole reader on each jump, and the
 * levels in between have no business knowing about comments.
 *
 * A **store** in the context, not the value itself. A context value re-renders
 * every consumer when it changes, and every row consumes this one — so each
 * jump re-rendered every mounted row, every call row and every comment button
 * to tell exactly one of them to open (~600ms on a long Session, on the click).
 * Through `useSyncExternalStore` each row's snapshot is only its own number,
 * so the rows a request is not for compare equal and skip the render.
 */
type FocusRequest = { anchorId: string; n: number } | null;

interface FocusStore {
  get: () => FocusRequest;
  set: (next: FocusRequest | ((prev: FocusRequest) => FocusRequest)) => void;
  subscribe: (listener: () => void) => () => void;
}

function createFocusStore(): FocusStore {
  let value: FocusRequest = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === "function" ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const NO_FOCUS: FocusStore = createFocusStore();
const FocusThreadContext = createContext<FocusStore>(NO_FOCUS);

/** The open signal for one anchor: a new number each time it is asked for. */
function useOpenSignal(anchorId: string) {
  const store = useContext(FocusThreadContext);
  return useSyncExternalStore(store.subscribe, () => {
    const focus = store.get();
    return focus?.anchorId === anchorId ? focus.n : undefined;
  });
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
  chatOpen = false,
  onToggleChat,
}: Props) {
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

// ── Masthead ────────────────────────────────────────────────────────────────

/**
 * Title, identity pills, and the four numbers worth leading with.
 *
 * The rhythm is deliberate and even: the same 22px sits between the title and
 * the pills as between the pills and the grid, and the 56px above the title
 * matches the 56px below the grid — so the header reads as one block with air
 * around it rather than three rows that happen to be stacked. Export is not
 * here; it lives in the header dock with the tab's other actions.
 */
function Masthead({
  detail,
  comments,
  projectPath,
}: {
  detail: Detail;
  comments: RowComments | null;
  projectPath: string;
}) {
  const openSignal = useOpenSignal(detail.summary.id);
  const s = detail.summary;
  const branch = s.branches[0];
  const pr = useBranchPullRequest(projectPath, branch ?? "");
  const tokens = tokenLabel(s);

  // Pricing is cached by Rust and refreshed in the background; a consumer has
  // to ask for it once. Cheap and idempotent — `load` is stable and the store
  // is shared, so opening ten Sessions reads the cache once.
  const prices = useModelPricingStore.use.prices();
  const { load: loadPrices } = useModelPricingStore.use.actions();
  useEffect(() => {
    void loadPrices();
  }, [loadPrices]);

  const spend: TokenSpend = {
    input: s.inputTokens,
    output: s.outputTokens,
    cacheWrite: s.cacheCreationTokens,
    cacheRead: s.cacheReadTokens,
  };
  const spent = spend.input + spend.output + spend.cacheWrite + spend.cacheRead;
  const cost = spent > 0 ? costOf(spend, priceForModel(prices, s.model)) : null;

  /**
   * Why the missing cells are drawn rather than dropped.
   *
   * Every live ACP session reports context occupancy and nothing else — no
   * split, no cache figures — so two of the four cells have nothing to say.
   * Rendering the grid two-wide for those was worse than the hole it avoided:
   * two cells stretched across the measure read as a layout that had broken,
   * and the row changed shape between Sessions. They keep their place, say
   * what is missing, and the grid is the same object every time.
   */

  return (
    <>
      {/* `group/row` so the session thread's button reveals on the same hover
       *  rule as every other one — it is the same control, at Session scope. */}
      <div className="group/row flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-xl font-semibold leading-[1.25] tracking-[-0.02em] text-[var(--foreground)]">
          {sessionTitle(s.title) ?? (
            <span className="text-[var(--muted-foreground)]">Untitled session</span>
          )}
        </h1>
        {/* The whole-Session thread, for anything that is not about one step. */}
        {comments && (
          <CommentButton
            anchorKind="session"
            anchorId={s.id}
            comments={comments.session}
            actions={comments.actions}
            directory={comments.directory}
            label="Comment on this Session"
            className="mt-1 group-hover/row:opacity-100"
            openSignal={openSignal}
          />
        )}
      </div>

      <div className="mt-[22px] flex min-w-0 flex-wrap items-center gap-2">
        {sessionState(s) === "live" && <LiveChip />}
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
        {pr !== null && (
          <Chip>
            <GitPullRequest size={11} />
            PR #{pr.number} open
          </Chip>
        )}
        <span className="font-mono text-xs text-[var(--muted-foreground)]">
          {timeAgo(s.lastActivityAt, { suffix: true })} · {formatDuration(s.activeSeconds)}
        </span>
        {s.needsAttention && (
          <span
            className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--atlas-status-warning-foreground)]/25 bg-[var(--atlas-status-warning-background)] px-2.5 font-mono text-xs text-[var(--atlas-status-warning-foreground)]"
            title={s.attentionReason ?? undefined}
          >
            <TriangleAlert size={11} />
            partial
          </span>
        )}
      </div>

      {branch && <ShipOverviewCard projectPath={projectPath} branch={branch} pr={pr} />}

      <div
        className={cn(
          // 2×2 in the dock, four across when there is room. Four cells over a
          // 620px panel left each one too narrow for its own figure, and the
          // Context bar in particular stopped being readable as a bar.
          //
          // `@4xl` is 728px here, not the 896 it would be on a 16px root —
          // this app's root is 13px, so every container step is proportionally
          // smaller and the breakpoint has to be read in pixels, not in `rem`.
          "mt-[22px] grid grid-cols-2 overflow-hidden rounded-md border border-[var(--border)] @4xl:grid-cols-4",
          "[&>*]:border-[var(--border)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t",
          "@4xl:[&>*+*]:border-l @4xl:[&>*:nth-child(n+3)]:border-t-0",
        )}
      >
        <Metric label="Active" value={formatDuration(s.activeSeconds)} sub={clock(s)} />
        <Metric
          label="Tokens"
          value={tokens ?? "—"}
          sub={tokenBreakdown(s) ?? (s.contextUsed != null ? "context window" : "not reported")}
        />
        {/* Context, not the token mix. The mix answered "where did the spend
            go", which the Tokens cell beside it already says in its caption;
            this answers "how close to the window's edge did the run get",
            which nothing else here says and which is the figure that decides
            whether a Session could have continued. */}
        {s.contextUsed != null && s.contextSize ? (
          <Cell label="Context">
            <ContextMeter used={s.contextUsed} size={s.contextSize} />
          </Cell>
        ) : (
          <Metric label="Context" value="—" sub="not reported" absent />
        )}
        {cost == null ? (
          <Metric
            label="Est. cost"
            value="—"
            sub={spent > 0 ? "no price for this model" : "no token split"}
            absent
          />
        ) : (
          <Metric
            label="Est. cost"
            value={costLabel(cost)}
            sub={prettyModel(s.model) ?? "unknown model"}
          />
        )}
      </div>
      <SecuritySummary projectPath={projectPath} sessionId={s.id} />
    </>
  );
}

/** One cell of the grid. The dividers are the grid's, not the cell's. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-[var(--card)] px-3.5 py-3">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * `absent` is the placeholder state: the figure is not merely zero, it was
 * never reported. It dims the value to the caption's own weight so the cell
 * reads as a held place rather than a number worth looking at.
 */
function Metric({
  label,
  value,
  sub,
  absent,
}: {
  label: string;
  value: string;
  sub: string;
  absent?: boolean;
}) {
  return (
    <Cell label={label}>
      <p
        className={cn(
          "mt-1.5 truncate font-mono text-lg font-medium tracking-[-0.02em]",
          absent ? "text-[var(--atlas-text-disabled)]" : "text-[var(--foreground)]",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate font-mono text-2xs text-[var(--atlas-text-disabled)]">{sub}</p>
    </Cell>
  );
}

/**
 * `$4.12`, or `<$0.01`.
 *
 * Two decimals is the unit people think in, but a short Session can genuinely
 * cost a fraction of a cent and rendering that as `$0.00` reads as "free"
 * rather than "very cheap".
 */
function costLabel(cost: number): string {
  return cost >= 0.01 ? fmtCost(cost) : `<${fmtCost(0.01)}`;
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 font-mono text-xs text-[var(--muted-foreground)]">
      {children}
    </span>
  );
}

/**
 * Still being written: the same breathing green dot as the Session's node on
 * the Timeline, with the word, because a dot alone in a row of grey chips read
 * as decoration. First in the row — it is the one chip that is status.
 */
function LiveChip() {
  return (
    <span className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--atlas-status-success-foreground)]/25 bg-[var(--atlas-status-success-background)] px-2.5 font-mono text-xs text-[var(--atlas-status-success-foreground)]">
      <span
        aria-hidden
        className="atlas-live-pulse size-1.5 rounded-full bg-[var(--atlas-status-success-foreground)]"
        style={{
          ["--atlas-pulse-color" as string]:
            "color-mix(in oklab, var(--atlas-status-success-foreground) 40%, transparent)",
        }}
      />
      live
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
      <span className="text-[var(--secondary-foreground)]">
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
 * — the fade's `more` and the jump button's `activeAnchor` — and without this
 * boundary every tick of either re-rendered every row, every code block and
 * every markdown body in the window. Now a scroll that changes only where the
 * reader is re-renders the action bar and the fade, and the list is skipped
 * outright.
 *
 * `landed` is the one prop that still moves per row, and it moves once per jump.
 */
const Timeline = memo(function Timeline({
  groups,
  projectPath,
  sessionId,
  agent,
  expandTools,
  landed,
  register,
  comments,
}: {
  groups: Group[];
  projectPath: string;
  sessionId: string;
  agent: string | null;
  expandTools: boolean;
  landed: string | null;
  register: (id: string, node: HTMLDivElement | null) => void;
  comments: RowComments | null;
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
          sessionId={sessionId}
          agent={agent}
          expandTools={expandTools}
          isLanded={group.entries.some((e) => e.id === landed)}
          landedCallId={
            // Including the run's FIRST call, which this used to exclude as
            // "already the row head, nothing to unfold". The ring does not need
            // the unfold — but the comment button does: a tool_call group never
            // renders one on its header (see `isCallRun`), so the only place to
            // hang the first call's thread off is its own row inside the fold.
            group.kind === "tool_call" && landed
              ? (group.entries.find((e) => e.id === landed)?.id ?? null)
              : null
          }
          register={register}
          comments={comments}
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
  sessionId,
  agent,
  expandTools,
  isLanded,
  landedCallId,
  register,
  comments,
}: {
  group: Group;
  first: boolean;
  last: boolean;
  projectPath: string;
  sessionId: string;
  agent: string | null;
  /** The global "always expand" switch from the filter drawer. */
  expandTools: boolean;
  /** A jump just landed here — ringed briefly. */
  isLanded: boolean;
  /** The landed entry, when it is one of this row's calls: the run has to
   *  unfold for it, both to ring it and to give its comment thread somewhere to
   *  open. `null` for every other row, so a jump does not re-render the whole
   *  window. */
  landedCallId: string | null;
  register: (id: string, node: HTMLDivElement | null) => void;
  /** `null` on a Session that is not shared — there is nothing to anchor to. */
  comments: RowComments | null;
}) {
  const head = group.entries[0];
  const openSignal = useOpenSignal(head.id);
  // A group of tool calls speaks for several anchors, not one. Every comment
  // surface below branches on it, so it is named once here.
  const isCallRun = group.kind === "tool_call";
  // Every thread on this row: the entry's own, plus each call's when the row is
  // a run of them. The activity lines under a folded run are the only place a
  // thread on its fifth call is visible without opening it.
  const threads = useMemo(
    () =>
      !comments
        ? undefined
        : isCallRun
          ? group.entries.flatMap((e) => comments.byAnchor[e.id] ?? [])
          : comments.byAnchor[head.id],
    [comments, isCallRun, group.entries, head.id],
  );
  return (
    <div
      ref={(node) => register(head.id, node)}
      className={cn(
        "atlas-entry grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 rounded-md transition-colors",
        isLanded && "ring-1 ring-[var(--atlas-border-strong)]",
      )}
    >
      <div className="relative flex justify-center">
        <span
          aria-hidden
          className="absolute left-1/2 -ml-px w-px bg-[var(--atlas-border-subtle)]"
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
              "text-base font-medium",
              group.kind === "checkpoint"
                ? "text-[var(--atlas-status-success-foreground)]"
                : group.kind === "prompt"
                  ? "text-[var(--foreground)]"
                  : "text-[var(--secondary-foreground)]",
            )}
          >
            {kindLabel(group)}
          </span>
          <span className="text-[var(--atlas-border-strong)]">·</span>
          <span className="font-mono text-xs text-[var(--muted-foreground)]">{time(head.at)}</span>
          {group.kind === "tool_call" && group.entries.length > 1 && (
            <span className="font-mono text-xs text-[var(--atlas-text-disabled)]">
              {group.entries.length} calls
            </span>
          )}
          {group.kind === "tool_call" && <CallStat calls={group.entries} />}

          {/* The row's controls, pushed right. The spacer is unconditional: a
           *  row with a comment button and no copy button still needs them
           *  over there, and two independent `flex-1`s would split the gap. */}
          <span className="flex-1" />
          <ActionCluster
            // A discussed row keeps its controls on screen. Hiding them behind
            // hover was the bug: the comment pill was visible (it has to be —
            // it is how a discussion announces itself) while the copy button
            // beside it was not, so the row showed a lone pill with a hole
            // next to it until the pointer arrived.
            pinned={comments && !isCallRun ? visibleCount(comments.byAnchor[head.id]) > 0 : false}
          >
            {/* Comment first, copy second. The comment button is the one that
             *  grows — faces and a count once a discussion exists — so
             *  outermost would make the copy button's position depend on how
             *  many people had replied. Every kind can be commented on, not
             *  just the two that can be copied: a tool call and a Checkpoint
             *  are exactly the things worth asking about.
             *
             *  A run of calls is the exception: this header can only anchor the
             *  FIRST of them, so each call carries its own button instead (see
             *  `CallRow`) and the aggregate lives on the fold. */}
            {comments && !isCallRun && (
              <CommentButton
                bare
                anchorKind={anchorKindFor(group.kind)}
                anchorId={head.id}
                comments={comments.byAnchor[head.id]}
                actions={comments.actions}
                directory={comments.directory}
                openSignal={openSignal}
              />
            )}
            {(group.kind === "prompt" || group.kind === "response") && head.text && (
              <CopyButton text={head.text} className="opacity-100" />
            )}
          </ActionCluster>
        </div>

        {isCallRun ? (
          <Calls
            calls={group.entries}
            projectPath={projectPath}
            expandAll={expandTools}
            comments={comments}
            revealId={landedCallId}
          />
        ) : group.kind === "checkpoint" ? (
          <Checkpoint entry={head} projectPath={projectPath} sessionId={sessionId} />
        ) : group.kind === "prompt" ? (
          <Prompt entry={head} projectPath={projectPath} />
        ) : (
          <Clamp>
            <div className="mt-1.5 text-base leading-[1.65] text-[var(--secondary-foreground)]">
              <Body entry={head} projectPath={projectPath} markdown={group.kind === "response"} />
            </div>
          </Clamp>
        )}

        {comments && <ActivityLog comments={threads} directory={comments.directory} />}
      </div>
    </div>
  );
});

/**
 * What was said about this node, under it.
 *
 * The record shows the work; these lines show the conversation about the work.
 * A count on a button says a discussion exists — it does not say a colleague
 * replied to you twenty minutes ago, which is the thing worth noticing while
 * reading past.
 *
 * Deliberately not interactive: the thread lives one click away in the pill
 * above, and a second way to open it would be a second place for the popover's
 * state to live.
 */
const ActivityLog = memo(function ActivityLog({
  comments,
  directory,
}: {
  comments: Comment[] | undefined;
  directory: OrgDirectory;
}) {
  const lines = useMemo(() => commentActivity(comments, directory), [comments, directory]);
  if (lines.length === 0) return null;

  return (
    // The lines are 14px faces against 11px text, so they read as a dense block
    // at a gap that would be fine for prose. Given room they read as a list.
    <div className="mt-4 flex flex-col gap-2">
      {lines.map((line) => {
        const member = directory.byId.get(line.authorId) ?? null;
        return (
          <div key={line.id} className="flex min-w-0 items-center gap-1.5">
            {member ? (
              <AccountAvatar user={avatarUser(member)} size={14} />
            ) : (
              <span className="size-[14px] shrink-0 rounded-full bg-[var(--atlas-element-selected)]" />
            )}
            <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">
              <span className="text-[var(--secondary-foreground)]">{line.actorName}</span>{" "}
              {!line.isReply
                ? "commented on this"
                : line.self
                  ? "replied to their own comment"
                  : line.targetName
                    ? `replied to ${line.targetName}'s comment`
                    : "replied to a comment"}
              <span aria-hidden className="px-1 text-[var(--atlas-text-disabled)]">
                ·
              </span>
              <span className="text-[var(--atlas-text-disabled)]">
                {timeAgo(line.at, { suffix: true })}
              </span>
            </span>
          </div>
        );
      })}
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
      ? "border-[var(--atlas-status-success-foreground)]/35 bg-[var(--atlas-status-success-foreground)]/10 text-[var(--atlas-status-success-foreground)]"
      : failed
        ? // Still legible as a failure without a ring: the fill carries it.
          "bg-[var(--atlas-status-error-foreground)]/70"
        : bare
          ? "bg-[var(--atlas-border-strong)]"
          : // Prompt + response rings at half strength. At full `--atlas-border-strong`
            // the outline competed with the glyph inside it, so the rail read as
            // a column of buttons rather than a quiet index of who did what.
            kind === "prompt"
            ? "border-[var(--atlas-border-strong)]/50 bg-[var(--card)] text-[var(--secondary-foreground)]"
            : kind === "response"
              ? "border-[var(--atlas-border-strong)]/50 bg-[var(--card)] text-[var(--secondary-foreground)]"
              : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]";

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
  comments,
  revealId,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  expandAll: boolean;
  comments: RowComments | null;
  /** A jump landed on one of these calls — unfold so it can be seen. */
  revealId?: string | null;
}) {
  const [open, setOpen] = useState(expandAll);
  useEffect(() => setOpen(expandAll), [expandAll]);
  // A jump to a call inside a folded run has to open the run. Not merged with
  // the line above: `expandAll` is a switch the reader set and must stay
  // authoritative when they turn it off again.
  useEffect(() => {
    if (revealId) setOpen(true);
  }, [revealId]);

  // Threads inside the fold, summed. A run of calls is folded by default, so
  // without this the only sign of a discussion on its third call would be the
  // count in the panel — the fold would look untouched.
  const inside = comments
    ? calls.reduce((n, call) => n + visibleCount(comments.byAnchor[call.id]), 0)
    : 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        Show tool calls
        <ChevronRight size={12} />
        {inside > 0 && (
          <span
            className="flex h-5 items-center gap-1 rounded-full border border-border bg-card pl-1.5 pr-1.5 text-[var(--secondary-foreground)]"
            aria-label={`${inside} ${inside === 1 ? "comment" : "comments"} on these tool calls`}
          >
            <MessageSquare size={11} />
            <span className="text-2xs tabular-nums">{inside > 9 ? "9+" : inside}</span>
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      <CallTable
        calls={calls}
        projectPath={projectPath}
        compact
        comments={comments}
        revealId={revealId}
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-1.5 flex cursor-pointer items-center gap-1 text-sm text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
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
        <span className="truncate font-mono text-xs text-[var(--atlas-text-disabled)]">
          {stat.parts.join(" · ")}
        </span>
      )}
      {stat.added > 0 && (
        <span className="font-mono text-xs text-[var(--atlas-diff-added-text)]">+{stat.added}</span>
      )}
      {stat.removed > 0 && (
        <span className="font-mono text-xs text-[var(--atlas-diff-removed-text)]">
          −{stat.removed}
        </span>
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

/** The compact call table behind a group's "Show tool calls". */
function CallTable({
  calls,
  projectPath,
  compact: dense,
  comments,
  revealId,
}: {
  calls: TimelineEntry[];
  projectPath: string;
  compact?: boolean;
  comments: RowComments | null;
  /** A jump landed on this call: expand it, and grow the window until it is
   *  mounted. Without this a comment on the fourth call of a run scrolled the
   *  group into view and stopped there. */
  revealId?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(CALL_WINDOW);
  // One stable handler for every row — the per-row closure was what forced the
  // whole table to re-render on a single expand.
  const toggle = useCallback((id: string) => setOpen((cur) => (cur === id ? null : id)), []);

  // A different call list is a different table — restart the window.
  useEffect(() => setShown(CALL_WINDOW), [calls]);

  useEffect(() => {
    if (!revealId) return;
    const at = calls.findIndex((c) => c.id === revealId);
    if (at === -1) return;
    setShown((cur) => (at < cur ? cur : at + 1));
    setOpen(revealId);
  }, [revealId, calls]);

  if (calls.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-[var(--muted-foreground)]">
        No tool calls match the current filters.
      </p>
    );
  }

  const visibleCalls = calls.length > shown ? calls.slice(0, shown) : calls;
  const hidden = calls.length - visibleCalls.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-[var(--border)]",
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
          comments={comments}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((cur) => cur + CALL_WINDOW_GROW)}
          className="flex h-9 w-full cursor-pointer items-center justify-center bg-[var(--card)] font-mono text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
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
 * The line is the transcript's — glyph, verb, target (`toolLine`) — rather than
 * the `toolName` / `paths[0]` columns it used to be. The two surfaces show the
 * same events to the same reader, and a comment made here is read back beside
 * that call in the live chat; recognising the call in both is the point.
 *
 * The comment button is on the CALL, not on the group above it. A group is a run
 * of consecutive calls and its header could only ever anchor the first one, so a
 * thread on the fourth call of a run had nowhere to render — it counted in the
 * panel and the badge and appeared nowhere in the timeline, which is the bug this
 * replaces.
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
  comments,
}: {
  call: TimelineEntry;
  dense?: boolean;
  expanded: boolean;
  divider: boolean;
  onToggle: (id: string) => void;
  projectPath: string;
  /** `null` on a Session that is not shared — there is nothing to anchor to. */
  comments: RowComments | null;
}) {
  const openSignal = useOpenSignal(call.id);
  const failed = call.toolStatus === "failed";
  // One parse of the recorded arguments per call, not per render: the table can
  // hold a Session's whole call history.
  const line = useMemo(() => toolLine(call), [call]);
  const thread = comments?.byAnchor[call.id];
  return (
    <div>
      <div
        className={cn(
          "group/row flex items-center gap-2 bg-[var(--card)] px-3 transition-colors hover:bg-[var(--atlas-element-hover)]",
          dense ? "h-8" : "h-9",
          divider && "border-b border-[var(--atlas-border-subtle)]",
        )}
      >
        {!dense && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-text-disabled)]">
            {time(call.at)}
          </span>
        )}
        <button
          type="button"
          onClick={() => onToggle(call.id)}
          title={line.detail ? `${line.verb} ${line.detail}` : line.verb}
          className="group/marker flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className="flex w-4 shrink-0 justify-center text-[var(--muted-foreground)]">
            <ToolGlyph tool={line.tool} failed={failed} />
          </span>
          {/* One run of text, so verb and target read as a sentence and a long
              command truncates as a line rather than as a separate column. */}
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              failed
                ? "text-[var(--atlas-status-error-foreground)]"
                : "text-[var(--secondary-foreground)]",
            )}
          >
            {line.verb}
            {line.detail && (
              <>
                {" "}
                <span
                  className={cn(
                    line.fileDetail &&
                      "text-[var(--atlas-text-disabled)] underline decoration-dotted underline-offset-[3px] group-hover/marker:text-[var(--secondary-foreground)]",
                  )}
                >
                  {line.detail}
                </span>
              </>
            )}
          </span>
          <ChevronRight
            size={12}
            className={cn(
              "shrink-0 text-[var(--atlas-border-strong)] transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        {/* A discussed call keeps its button on screen — that is how the
            discussion announces itself; an undiscussed one reveals on hover
            like every other Timeline control. */}
        {comments && (
          <ActionCluster pinned={visibleCount(thread) > 0}>
            <CommentButton
              bare
              anchorKind="tool_call"
              anchorId={call.id}
              comments={thread}
              actions={comments.actions}
              directory={comments.directory}
              openSignal={openSignal}
            />
          </ActionCluster>
        )}
      </div>

      {expanded && (
        <div className="space-y-2.5 border-b border-[var(--atlas-border-subtle)] bg-[var(--background)] px-3 py-3">
          {call.paths.length > 0 && (
            <p className="font-mono text-xs text-[var(--muted-foreground)]">
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
              rowId={call.id}
              part="arguments"
            />
          )}
          {call.resultBinary ? (
            <p className="font-mono text-xs text-[var(--muted-foreground)]">
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
                rowId={call.id}
                part="result"
              />
            )
          )}
          {!call.arguments && !call.result && !call.resultBinary && (
            <p className="font-mono text-xs text-[var(--atlas-text-disabled)]">
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
function Checkpoint({
  entry,
  projectPath,
  sessionId,
}: {
  entry: TimelineEntry;
  projectPath: string;
  sessionId: string;
}) {
  const orphaned = entry.linkState === "orphaned";
  return (
    <div
      className={cn(
        "mt-2.5 overflow-hidden rounded-md border",
        orphaned
          ? "border-dashed border-[var(--atlas-border-strong)]"
          : "border-[var(--border)] bg-[var(--card)]",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--atlas-border-subtle)] bg-[var(--card)] px-3 py-2">
        <GitCommitHorizontal size={13} className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="shrink-0 font-mono text-xs text-[var(--muted-foreground)]">
          {entry.commitSha?.slice(0, 7)}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            orphaned ? "text-[var(--secondary-foreground)]" : "text-[var(--foreground)]",
          )}
        >
          {entry.commitSubject ?? (
            // The Checkpoint is a real record even when git can no longer
            // resolve it — a moved repository or a pruned commit must not
            // erase it.
            <span className="text-[var(--muted-foreground)]">
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
            className="shrink-0 rounded-full bg-[var(--atlas-status-warning-background)] px-2 py-px font-mono text-2xs text-[var(--atlas-status-warning-foreground)]"
            title="This commit is no longer in history — rewritten or squashed. The Session record is kept."
          >
            orphaned
          </span>
        )}
        {entry.insertions > 0 && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-diff-added-text)]">
            +{entry.insertions}
          </span>
        )}
        {entry.deletions > 0 && (
          <span className="shrink-0 font-mono text-xs text-[var(--atlas-diff-removed-text)]">
            −{entry.deletions}
          </span>
        )}
      </div>

      {entry.files.length > 0 && (
        <ul className="px-3 py-2">
          {entry.files.slice(0, 12).map((file) => (
            <li
              key={file}
              className="truncate font-mono text-xs leading-[1.75] text-[var(--muted-foreground)]"
            >
              {file}
            </li>
          ))}
          {entry.files.length > 12 && (
            <li className="font-mono text-xs leading-[1.75] text-[var(--atlas-text-disabled)]">
              +{entry.files.length - 12} more
            </li>
          )}
        </ul>
      )}

      {entry.commitSha && !orphaned && (
        <CheckpointFindings
          projectPath={projectPath}
          sessionId={sessionId}
          commitSha={entry.commitSha}
        />
      )}

      {/* Suppressed when orphaned: the branch no longer contains this commit,
       *  so showing it would assert exactly the link that was lost. */}
      {entry.branch && !orphaned && (
        <p className="border-t border-[var(--atlas-border-subtle)] px-3 py-1.5 font-mono text-xs text-[var(--atlas-text-disabled)]">
          {entry.branch}
        </p>
      )}
    </div>
  );
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * The filter menu: what the timeline shows, and a way through its Checkpoints.
 *
 * A popover off the footer's filter button (`footer-pill.tsx`), opening up
 * out of the bottom-left. It was a 340px drawer over the right of the reader,
 * which nothing opened once the footer became two morphs; a menu keeps the
 * reader in view while you narrow it, so a toggle's effect shows as you make
 * it.
 *
 * Checkpoints come first, because "take me to the commit" is the question
 * the menu is most often opened with: previous / next step from wherever the
 * reader is, and the list jumps to any one of them.
 */
function FilterMenu({
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
  search,
  setSearch,
  activeFilters,
  checkpoints,
  currentCheckpoint,
  onJump,
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
  search: string;
  setSearch: (v: string) => void;
  activeFilters: number;
  /** Every Checkpoint in the Session, in timeline order. */
  checkpoints: TimelineEntry[];
  /** Where the reader is among them — see `currentCheckpoint` in the pane. */
  currentCheckpoint: () => number;
  onJump: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Re-measured on open: the popup mounts with it, and a closed one has no
  // geometry to read.
  const bodyEdges = useScrollEdges(bodyRef, [open, checkpoints.length, detail.tools.length]);
  const s = detail.summary;
  const kinds: Array<[keyof TimelineFilters, string, number]> = [
    ["prompts", "Prompts", detail.counts.prompts],
    ["responses", "Responses", detail.counts.responses],
    ["thinking", "Thinking", detail.counts.thinking],
    ["toolCalls", "Tool calls", detail.counts.toolCalls],
    ["checkpoints", "Checkpoints", detail.counts.checkpoints],
  ];

  const step = (direction: -1 | 1) => {
    const at = currentCheckpoint();
    // On a Checkpoint (a whole index), step off it; between two (a half), the
    // nearer one in that direction is the next whole index that way.
    const target = Number.isInteger(at)
      ? at + direction
      : direction === 1
        ? Math.ceil(at)
        : Math.floor(at);
    const checkpoint = checkpoints[target];
    if (checkpoint) onJump(checkpoint.id);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label={activeFilters > 0 ? `Filters · ${activeFilters} active` : "Filter and jump"}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className={cn(PILL_BUTTON, activeFilters > 0 && PILL_BUTTON_ACTIVE)}
            >
              <SlidersHorizontal size={PILL_ICON} strokeWidth={1.7} />
              {activeFilters > 0 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-foreground"
                />
              )}
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="top" align="start" sideOffset={8}>
          {/* Opaque, in the page's own appearance — black on a dark theme,
              light on a light one. The ground is the theme's background and
              what sits on it — the Checkpoint cards — the raised popover grey,
              so the cards pop rather than the menu. It was the card colour at
              90% under a blur, which let the timeline's text show through. */}
          <Popover.Popup
            aria-label="Filter the timeline"
            className="flex max-h-[min(36rem,calc(100svh-8rem))] w-[340px] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-lg data-closed:animate-scale-out data-open:animate-scale-in"
          >
            <label className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
              <Search size={13} className="shrink-0 text-[var(--muted-foreground)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find in this session…"
                aria-label="Find in this session"
                spellCheck={false}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
              />
              {activeFilters > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setFilters(() => DEFAULT_FILTERS);
                    setFailedOnly(false);
                    setTools(() => new Set());
                    setSearch("");
                  }}
                  className="h-[22px] shrink-0 cursor-pointer rounded-full border border-[var(--border)] px-2.5 text-2xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                >
                  Reset {activeFilters}
                </button>
              )}
            </label>

            <div className="relative flex min-h-0 flex-1 flex-col">
              <ScrollFade at="top" visible={bodyEdges.top} className={POPOVER_FADE} />
              <ScrollFade at="bottom" visible={bodyEdges.bottom} className={POPOVER_FADE} />
              <div
                ref={bodyRef}
                className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3.5 pb-4 pt-3.5"
              >
                {checkpoints.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
                        Checkpoints
                      </span>
                      <span className="font-mono text-2xs text-muted-foreground">
                        {checkpoints.length}
                      </span>
                      <span className="flex-1" />
                      {/* The sidebar's outlined round buttons (its +): stepping
                        is the menu's one verb, so it reads as a control
                        rather than a glyph in a label row. */}
                      <span className="flex items-center gap-1.5">
                        <GlassIconButton
                          icon={ChevronUp}
                          label="Previous checkpoint"
                          onClick={() => step(-1)}
                        />
                        <GlassIconButton
                          icon={ChevronDown}
                          label="Next checkpoint"
                          onClick={() => step(1)}
                        />
                      </span>
                    </div>
                    <CheckpointList
                      checkpoints={checkpoints}
                      onJump={(id) => {
                        // The menu covers the reader's lower left, and a jump
                        // centres its target; close it so the landing is seen.
                        setOpen(false);
                        onJump(id);
                      }}
                    />
                  </div>
                )}

                <Section label="Show" hint={`${detail.entries.length} events`}>
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

                {/* A display preference, not a filter — it hides nothing, so it is
                 *  not counted in the active badge and Reset leaves it alone. */}
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
                    dot="var(--atlas-status-error-foreground)"
                    onClick={() => setFailedOnly(!failedOnly)}
                  />
                </Section>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Every commit this Session produced, as a list to jump into.
 *
 * Inline in the menu rather than the searchable dropdown it was in the
 * drawer: a popover inside a popover fights over focus and dismissal. Past
 * a handful, a filter field narrows it — by the time you look for a commit
 * in a long Session you usually know a word of its subject.
 */
function CheckpointList({
  checkpoints,
  onJump,
}: {
  checkpoints: TimelineEntry[];
  onJump: (entryId: string) => void;
}) {
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
   *  Session even when the search has narrowed what's shown. */
  const ordinal = useMemo(() => new Map(checkpoints.map((c, i) => [c.id, i + 1])), [checkpoints]);

  const listRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef, [matches.length]);

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {checkpoints.length > 4 && (
        <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border bg-popover px-2.5 transition-colors focus-within:border-foreground/25">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a commit…"
            aria-label="Find a commit"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
      {/* Each Checkpoint a filled card a step off the menu, so a list of
          them reads as things to pick rather than lines of text. Past the
          list's height it scrolls under a fade in the menu's own colour. */}
      <div className="relative">
        <ScrollFade at="top" visible={edges.top} className={cn(POPOVER_FADE, "h-8")} />
        <ScrollFade at="bottom" visible={edges.bottom} className={cn(POPOVER_FADE, "h-8")} />
        <div ref={listRef} className="hide-scrollbar flex max-h-56 flex-col gap-1 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">No match.</p>
          ) : (
            matches.map((checkpoint, i) => {
              const sha = checkpoint.commitSha ?? "";
              const changed = checkpoint.insertions + checkpoint.deletions;
              return (
                <button
                  key={checkpoint.id}
                  type="button"
                  onClick={() => onJump(checkpoint.id)}
                  className="flex w-full shrink-0 cursor-pointer flex-col gap-1 rounded-lg bg-popover px-3 py-2 text-left transition-colors duration-fast hover:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_7%)] focus-visible:bg-[color-mix(in_srgb,var(--popover),var(--foreground)_7%)] focus-visible:outline-none"
                >
                  <span className="truncate text-sm text-foreground">
                    {checkpoint.commitSubject ?? (
                      <span className="text-secondary-foreground">Subject unavailable</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
                    <span>
                      #{ordinal.get(checkpoint.id) ?? i + 1} · {sha.slice(0, 7)}
                    </span>
                    {changed > 0 && (
                      <>
                        <span>·</span>
                        <span className="text-[var(--atlas-diff-added-text)]">
                          +{checkpoint.insertions}
                        </span>
                        <span className="text-[var(--atlas-diff-removed-text)]">
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
      </div>
    </div>
  );
}

/** The scroll fades inside the filter menu: a ramp from the menu's own
 *  ground, so the content blends into it rather than being cut. */
const POPOVER_FADE = "from-background via-background/80";

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
          {label}
        </span>
        {hint && <span className="font-mono text-2xs text-muted-foreground">{hint}</span>}
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
        "flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-sm transition-colors",
        !enabled
          ? "cursor-default border-[var(--atlas-border-subtle)] text-[var(--atlas-text-disabled)]"
          : on
            ? "cursor-pointer border-border bg-[var(--atlas-element-active)] text-[var(--foreground)]"
            : "cursor-pointer border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
    >
      {dot && enabled && (
        <span className="size-[5px] rounded-full" style={{ backgroundColor: dot }} />
      )}
      {label}
      <span className="font-mono text-2xs text-muted-foreground">{count}</span>
    </button>
  );
}

// ── Content primitives ──────────────────────────────────────────────────────

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
            background: "linear-gradient(to bottom, transparent, var(--background))",
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
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--secondary-foreground)] shadow-md transition-colors hover:border-[var(--atlas-border-strong)] hover:text-[var(--foreground)]"
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
    <div className="overflow-hidden rounded-lg border border-[var(--atlas-border-subtle)] bg-[var(--card)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--atlas-element-hover)]"
      >
        <AtlasIcon size={12} className="shrink-0 rounded-sm" />
        <span className="text-sm text-[var(--secondary-foreground)]">
          {MEMORY_LABELS[block.label] ?? block.label.toLowerCase()}
        </span>
        <span className="font-mono text-xs text-[var(--atlas-text-disabled)]">
          from Atlas memory
        </span>
        <span className="flex-1" />
        {lines > 0 && (
          <span className="font-mono text-xs text-[var(--atlas-text-disabled)]">
            {lines} line{lines === 1 ? "" : "s"}
          </span>
        )}
        <ChevronRight
          size={12}
          className={cn(
            "text-[var(--atlas-border-strong)] transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="hide-scrollbar max-h-[320px] overflow-auto whitespace-pre-wrap break-words border-t border-[var(--atlas-border-subtle)] px-3.5 py-2.5 font-mono text-xs leading-[1.7] text-[var(--muted-foreground)]">
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
    <div className="mt-2.5 whitespace-pre-wrap break-words rounded-md border border-[var(--atlas-border-subtle)] bg-[var(--card)] px-3.5 py-3 font-mono text-sm leading-[1.75] text-[var(--secondary-foreground)]">
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
  rowId,
  part,
}: {
  label: string;
  text: string;
  path?: string | null;
  /** Force JSON: arguments are always an object, whatever they look like. */
  json?: boolean;
  projectPath: string;
  blobRef: string | null;
  rowId: string;
  part: PayloadPart;
}) {
  const remote = useContext(RemoteSourceContext);
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
      {(blobRef || remote) && full === null && (
        <ShowFull
          projectPath={projectPath}
          blobRef={blobRef}
          rowId={rowId}
          part={part}
          onLoaded={setFull}
        />
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
  const remote = useContext(RemoteSourceContext);
  const [full, setFull] = useState<string | null>(null);
  const truncated = entry.truncated && full === null;

  const notice = truncated && (
    <>
      <span className="ml-1 text-xs text-[var(--muted-foreground)]">
        … {compact(entry.bodyBytes)} bytes not shown
      </span>
      {(entry.bodyRef || remote) && (
        <ShowFull
          projectPath={projectPath}
          blobRef={entry.bodyRef}
          rowId={entry.id}
          part="body"
          onLoaded={setFull}
        />
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
 * Expand a payload the timeline only carries a preview of.
 *
 * The failure copy matters: a pruned blob store is a real state (the Session
 * still renders from previews) and "could not load" must not read as a crash.
 *
 * Two sources, because there are two places an oversized payload can live. A
 * Session captured on this machine spilled it to the local blob sidecar and is
 * addressed by content key. One captured elsewhere was never written here at
 * all — the server holds it, addressed by the entry's row id and which part of
 * it you want. `blobRef` picks the first; the remote context picks the second.
 */
/** Which half of an entry to fetch. Mirrors the server's `part` parameter. */
type PayloadPart = "body" | "arguments" | "result";

function ShowFull({
  projectPath,
  blobRef,
  onLoaded,
  rowId,
  part,
}: {
  projectPath: string;
  /** `null` on a remote Session — nothing was spilled to this disk. */
  blobRef: string | null;
  /** The entry the payload belongs to, for the remote read. */
  rowId: string;
  part: PayloadPart;
  onLoaded: (text: string) => void;
}) {
  const remote = useContext(RemoteSourceContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFull = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = blobRef
        ? await invoke<ArtifactPayload>("artifacts_payload", { projectPath, blobRef })
        : await invoke<ArtifactPayload>("artifacts_cloud_payload", {
            projectId: remote?.projectId,
            sessionId: remote?.sessionId,
            rowId,
            part,
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
    return <span className="ml-1.5 text-xs text-[var(--muted-foreground)]">{error}</span>;
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void fetchFull()}
      className="ml-1.5 inline-flex cursor-pointer items-center gap-1 text-xs text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors hover:no-underline hover:text-[var(--foreground)] disabled:opacity-60"
    >
      {busy && <Loader2 size={10} className="animate-spin" />}
      Show full
    </button>
  );
}

function Empty({
  detail,
  pending,
  failedOnly,
  failedCount,
}: {
  detail: Detail;
  /** The timeline has not arrived yet — say so rather than claiming it is empty. */
  pending: boolean;
  failedOnly: boolean;
  failedCount: number;
}) {
  if (pending) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-center text-sm text-[var(--muted-foreground)]">
        <Loader2 size={12} className="animate-spin" />
        Loading the timeline…
      </p>
    );
  }
  return (
    <p className="py-16 text-center text-sm text-[var(--muted-foreground)]">
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
  const fmt = (iso: string) => formatTime(iso, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(s.startedAt)} → ${fmt(s.lastActivityAt)} · ${formatDuration(s.wallSeconds)} span`;
}

function time(iso: string): string {
  return formatTime(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
