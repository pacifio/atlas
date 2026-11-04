import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button, EmptyState, GradualBlur, Hint, Icon, Skeleton } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { useTranscriptScroll } from "@/features/chat/lib/use-transcript-scroll";
import { animatedScrollTo } from "@/features/artifacts/lib/scroll-to";
import { formatDayDivider } from "../../lib/derive";

/**
 * Writing this to `scrollTop` and letting the browser clamp is the one way to
 * reach the bottom WITHOUT reading `scrollHeight` — which forces a synchronous
 * layout, and was the only layout read left in the scroll path.
 */
const SCROLL_BOTTOM = 1 << 30;

/** Height of the top blur ramp; content padding must clear it. */
const TOP_FADE = 36;

/** Items mounted when a conversation opens. Enough to overfill the viewport,
 *  so the reader never lands on a document too short to scroll. */
const WINDOW_INITIAL = 80;

/** Items added each time the reader nears the top of what is mounted. */
const WINDOW_CHUNK = 40;

/** One entry on the timeline: a run of messages, or a call. */
export type TranscriptItem =
  | {
      kind: "group";
      key: string;
      newDay: boolean;
      dayAt: number;
      /** The first message the reader has not seen heads this group: the
       *  "New messages" rule is drawn above it. */
      unreadBefore: boolean;
    }
  | { kind: "call"; key: string };

export interface TranscriptHandle {
  /** Scroll a message into the centre and flash it, mounting its item first
   *  if it sits above the window. */
  scrollToMessage: (messageId: string) => void;
}

export interface ConversationTranscriptViewProps<T extends TranscriptItem> {
  ref?: Ref<TranscriptHandle>;
  items: T[];
  renderItem: (item: T) => ReactNode;
  /** Whether an item holds a message: how a jump finds what to mount. */
  containsMessage: (item: T, messageId: string) => boolean;
  status: "loading" | "error" | "ready";
  error?: string;
  onRetry: () => void;
  /** Shown above the history once it has loaded. */
  intro: { title: string; body: string } | null;
  typingLabel: string | null;
  /** Grows by the number of messages that arrived; counted while scrolled up. */
  messageCount: number;
  /** The server may hold history older than what is loaded. */
  hasOlder: boolean;
  /** Page older history in. Resolves `true` when anything arrived. */
  onLoadOlder: () => Promise<boolean>;
  /** A file is being dragged over the column. */
  dropActive: boolean;
  /** Changes on a conversation switch: back to the live edge. */
  convKey: string;
  /** The composer, under the jump pill. */
  composer: ReactNode;
}

/**
 * The messages column: the scroller, its overlays, and the composer under it.
 *
 * Overlays are SIBLINGS of the scroller, never inside the content — the
 * transcript pattern. `relative` scopes them; nothing here transforms (the
 * vibrant-panel rule), and every overlay is pointer-events-none.
 *
 * **Windowed, not virtualised** — the session transcript's discipline. The
 * newest `WINDOW_INITIAL` items mount; scrolling near the top mounts
 * `WINDOW_CHUNK` more, and once everything loaded is mounted it pages older
 * history in from the server. The window is held by the KEY of its first item,
 * so appends below and history paged in above never shift which rows are
 * mounted. Every grow re-anchors: the row the reader was looking at goes back
 * under the same pixel in the same frame.
 */
export function ConversationTranscriptView<T extends TranscriptItem>({
  ref,
  items,
  renderItem,
  containsMessage,
  status,
  error,
  onRetry,
  intro,
  typingLabel,
  messageCount,
  hasOlder,
  onLoadOlder,
  dropActive,
  convKey,
  composer,
}: ConversationTranscriptViewProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = SCROLL_BOTTOM;
  }, []);

  // ── The window ───────────────────────────────────────────────────────
  // `start`: the key of the first mounted item; `null` mounts everything;
  // `undefined` is "not decided yet" (a conversation whose history has not
  // arrived), decided the first render there is something to window.
  const [win, setWin] = useState<{ conv: string; start: string | null | undefined }>({
    conv: convKey,
    start: undefined,
  });
  let start = win.conv === convKey ? win.start : undefined;
  if (start === undefined && items.length > 0) {
    start = items.length > WINDOW_INITIAL ? items[items.length - WINDOW_INITIAL].key : null;
  }
  if (win.conv !== convKey || win.start !== start) setWin({ conv: convKey, start });

  const found = start == null ? 0 : items.findIndex((item) => item.key === start);
  // A key that vanished (history regrouped under it) falls back to a fresh window.
  const startIndex = found >= 0 ? found : Math.max(0, items.length - WINDOW_INITIAL);
  const visible = startIndex === 0 ? items : items.slice(startIndex);
  const firstKey = visible[0]?.key;

  const growAnchor = useRef<{ key: string; offset: number } | null>(null);
  const loadingOlder = useRef(false);

  /** The item the reader is looking at, and how far below the top it sits. */
  const captureAnchor = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const nodes = el.querySelectorAll<HTMLElement>("[data-item-key]");
    let anchor: HTMLElement | null = null;
    for (const node of nodes) {
      anchor = node;
      if (node.offsetTop + node.offsetHeight > top) break;
    }
    growAnchor.current =
      anchor?.dataset.itemKey !== undefined
        ? { key: anchor.dataset.itemKey, offset: anchor.offsetTop - top }
        : null;
  }, []);

  const onGrow = () => {
    if (startIndex > 0) {
      const next = startIndex - WINDOW_CHUNK;
      setWin({ conv: convKey, start: next <= 0 ? null : items[next].key });
      return;
    }
    // Everything loaded is mounted: page older history in, once at a time.
    if (loadingOlder.current) return;
    loadingOlder.current = true;
    void onLoadOlder().then(
      (arrived) => {
        loadingOlder.current = false;
        // Nothing arrived, so nothing will re-render to land the anchor:
        // release the grow here or the loop never grows again.
        if (!arrived) settleGrow();
      },
      () => {
        loadingOlder.current = false;
        settleGrow();
      },
    );
  };

  // Keep the reader pinned to the live edge through content growth the way the
  // reference clients do: a reaction growing a row, an image resolving its
  // aspect ratio, the composer growing — all of it re-pins when at the end.
  const { more, onScroll, invalidate, atEndRef, growPending } = useTranscriptScroll({
    scrollRef: scroller,
    contentRef: content,
    // Not while loading: paging before the first page lands would read as
    // "no older history" for the rest of the visit.
    canGrow: status === "ready" && items.length > 0 && (startIndex > 0 || hasOlder),
    onGrow,
    onBeforeGrow: captureAnchor,
    onContentResize: () => {
      if (atEndRef.current) {
        const el = scroller.current;
        if (el) el.scrollTop = SCROLL_BOTTOM;
      }
    },
  });

  function settleGrow() {
    growAnchor.current = null;
    growPending.current = false;
    invalidate();
  }

  // Re-anchor after the window grew (or history arrived above it): put the
  // recorded item back under the same pixel, before paint.
  useLayoutEffect(() => {
    const el = scroller.current;
    const anchor = growAnchor.current;
    if (el && anchor) {
      const node = el.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(anchor.key)}"]`);
      if (node) el.scrollTop = Math.max(0, node.offsetTop - anchor.offset);
    }
    // Released even without an anchor to restore, or the scroll loop would
    // wait on this grow forever.
    growAnchor.current = null;
    growPending.current = false;
    invalidate();
  }, [firstKey, growPending, invalidate]);

  // ── Jumps ────────────────────────────────────────────────────────────
  const pendingJump = useRef<string | null>(null);
  const flash = useCallback(
    (messageId: string) => {
      const el = scroller.current;
      if (!el) return false;
      const node = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
      if (!node) return false;
      // A jump is a deliberate departure from the live edge — without
      // this, the bottom-pin yanks the view straight back down.
      atEndRef.current = false;
      animatedScrollTo(el, node, { block: "center" });
      node.classList.remove("atlas-jump-flash");
      // Force a restart when the same row is jumped to twice in a row.
      void node.offsetWidth;
      node.classList.add("atlas-jump-flash");
      const done = () => node.classList.remove("atlas-jump-flash");
      node.addEventListener("animationend", done, { once: true });
      setTimeout(done, 1400);
      return true;
    },
    [atEndRef],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (messageId) => {
        const index = items.findIndex((item) => containsMessage(item, messageId));
        if (index >= 0 && index < startIndex) {
          // Above the window: mount down to it, then scroll once it renders.
          pendingJump.current = messageId;
          setWin({ conv: convKey, start: index === 0 ? null : items[index].key });
          return;
        }
        flash(messageId);
      },
    }),
    [items, startIndex, containsMessage, convKey, flash],
  );

  // One attempt, on the commit that mounted the widened window: a jump that
  // still finds nothing must not fire later on some unrelated render.
  useLayoutEffect(() => {
    const id = pendingJump.current;
    if (!id) return;
    pendingJump.current = null;
    flash(id);
  });

  // Unseen-message count for the pill label. Counted only while away from the
  // live edge; cleared the moment the reader returns. History paged in above
  // also raises the message count, and is not news: a change of first item
  // marks it.
  const [newCount, setNewCount] = useState(0);
  const prevCount = useRef(messageCount);
  const prevFirst = useRef(items[0]?.key);
  const headKey = items[0]?.key;
  useLayoutEffect(() => {
    const grew = messageCount - prevCount.current;
    const prepended = headKey !== prevFirst.current;
    prevCount.current = messageCount;
    prevFirst.current = headKey;
    if (grew > 0 && !prepended && !atEndRef.current) {
      setNewCount((n) => n + grew);
    }
    if (atEndRef.current) {
      scrollToBottom();
      setNewCount(0);
    }
    invalidate();
  }, [messageCount, headKey, atEndRef, invalidate, scrollToBottom]);

  useEffect(() => {
    if (!more && newCount !== 0) setNewCount(0);
  }, [more, newCount]);

  // A conversation switch lands at the live edge.
  useEffect(() => {
    scrollToBottom();
    atEndRef.current = true;
    pendingJump.current = null;
  }, [convKey, atEndRef, scrollToBottom]);

  return (
    <>
      <div data-view="comms-conversation" className="relative flex min-h-0 flex-1 flex-col">
        <GradualBlur
          position="top"
          height={`${TOP_FADE}px`}
          strength={2}
          layers={4}
          tint="color-mix(in srgb, var(--background) 90%, transparent)"
          className="z-panel"
        />

        {/* Drop hint over the transcript. Opacity only — no transform inside
            the vibrant panel — and pointer-events-none so the webview keeps
            hit-testing the drop against the column. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-panel flex items-center justify-center",
            "bg-primary/8 transition-opacity duration-150",
            dropActive ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="rounded-full border border-primary/40 bg-card px-3 py-1 text-xs font-medium text-secondary-foreground shadow">
            Drop files to attach
          </span>
        </div>

        <div
          ref={scroller}
          onScroll={onScroll}
          className="hide-scrollbar min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        >
          {/* `px-4`: the column's gutter, so avatars, date rules and call rows
              sit off the pane's edge rather than against it. */}
          <div
            ref={content}
            className="px-4"
            style={{ paddingTop: TOP_FADE / 2, paddingBottom: 10 }}
          >
            {status === "loading" ? (
              <TranscriptSkeleton />
            ) : status === "error" ? (
              <EmptyState
                title="Couldn’t load this conversation"
                description={error}
                action={
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    <Icon icon={RefreshCw} size="sm" />
                    Try again
                  </Button>
                }
              />
            ) : (
              // The intro is the beginning of the conversation: only once
              // there is nothing older left to mount or page in.
              intro &&
              startIndex === 0 &&
              !hasOlder && (
                <div className="px-4 pb-3 pt-4">
                  <div className="text-base font-semibold text-foreground">{intro.title}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-disabled">{intro.body}</p>
                </div>
              )
            )}

            {visible.map((item) => (
              <div key={item.key} data-item-key={item.key}>
                {item.kind === "group" && item.newDay && <DayDivider at={item.dayAt} />}
                {item.kind === "group" && item.unreadBefore && <UnreadMarker />}
                {renderItem(item)}
              </div>
            ))}

            {/* Always mounted, so a screen reader hears each change of who is
                typing; an aria-live region that mounts with its text is not
                announced. */}
            <div aria-live="polite">{typingLabel && <TypingHint label={typingLabel} />}</div>
          </div>
        </div>

        {/* Bottom fade. Overshoots by 2px on purpose: at fractional UI scales
            the fade and the scroller bottom round to different device pixels
            and a hairline of text flashes through. Full colour at 72% — a
            two-stop gradient is only ~97% opaque just above the composer and
            text ghosts through on near-black. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute -bottom-[2px] left-0 right-0 z-panel h-[44px] transition-opacity duration-200",
            more ? "opacity-100" : "opacity-0",
          )}
          style={{
            background:
              "linear-gradient(to bottom, transparent, var(--background) 72%, var(--background))",
          }}
        />
      </div>

      <div className="relative">
        {more && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center">
            {/* The pill's entrance (`atlas-pill-in`) runs on a wrapper, so the
                package button keeps its own press dip. */}
            <span className="atlas-pill-in pointer-events-auto inline-flex">
              <Hint label="Jump to latest">
                <Button variant="secondary" size="sm" onClick={scrollToBottom}>
                  <Icon icon={ChevronDown} size="sm" />
                  {newCount > 0
                    ? `${newCount} new message${newCount === 1 ? "" : "s"}`
                    : "Scroll to bottom"}
                </Button>
              </Hint>
            </span>
          </div>
        )}
        {composer}
      </div>
    </>
  );
}

/** Where the unread messages start: a rule in the error tone, labelled. */
function UnreadMarker() {
  return (
    <div role="separator" aria-label="New messages" className="flex items-center gap-2 px-3 py-2">
      <span className="h-px flex-1 bg-error/50" />
      <span className="text-2xs font-medium text-error">New messages</span>
    </div>
  );
}

function DayDivider({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3">
      <span className="h-px flex-1 bg-border-subtle" />
      <span className="text-2xs font-medium uppercase tracking-wide text-disabled">
        {formatDayDivider(at)}
      </span>
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

function TypingHint({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-disabled">
      <span className="flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-[3px] animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}

/**
 * Message-shaped placeholders for a transcript that has not arrived, on the
 * package `Skeleton`: its pulse is opacity-only, which matters here — this
 * renders inside `atlas-vibrant-panel`, whose grain overlay makes WKWebView
 * mis-composite anything animating a transform. Round shapes clip the bar in a
 * wrapper so the primitive keeps its own look.
 */
function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-2">
          <span className="size-[30px] shrink-0 overflow-hidden rounded-full">
            <Skeleton className="size-full" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
            <Skeleton className="h-[9px]" style={{ width: 90 + ((i * 31) % 50) }} />
            <Skeleton className="h-[8px]" style={{ width: `${58 + ((i * 17) % 34)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
