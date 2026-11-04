import {
  Fragment,
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

/** One entry on the timeline: a run of messages, or a call. */
export type TranscriptItem =
  | { kind: "group"; key: string; newDay: boolean; dayAt: number }
  | { kind: "call"; key: string };

export interface TranscriptHandle {
  /** Scroll a rendered message into the centre and flash it. */
  scrollToMessage: (messageId: string) => void;
}

export interface ConversationTranscriptViewProps<T extends TranscriptItem> {
  ref?: Ref<TranscriptHandle>;
  items: T[];
  renderItem: (item: T) => ReactNode;
  status: "loading" | "error" | "ready";
  error?: string;
  onRetry: () => void;
  /** Shown above the history once it has loaded. */
  intro: { title: string; body: string } | null;
  typingLabel: string | null;
  /** Grows by the number of messages that arrived; counted while scrolled up. */
  messageCount: number;
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
 */
export function ConversationTranscriptView<T extends TranscriptItem>({
  ref,
  items,
  renderItem,
  status,
  error,
  onRetry,
  intro,
  typingLabel,
  messageCount,
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

  // Keep the reader pinned to the live edge through content growth the way the
  // reference clients do: a reaction growing a row, an image resolving its
  // aspect ratio, the composer growing — all of it re-pins when at the end.
  const { more, onScroll, invalidate, atEndRef } = useTranscriptScroll({
    scrollRef: scroller,
    contentRef: content,
    canGrow: false,
    onGrow: () => {},
    onContentResize: () => {
      if (atEndRef.current) {
        const el = scroller.current;
        if (el) el.scrollTop = SCROLL_BOTTOM;
      }
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (messageId) => {
        const el = scroller.current;
        if (!el) return;
        const node = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`);
        if (!node) return;
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
      },
    }),
    [atEndRef],
  );

  // Unseen-message count for the pill label. Counted only while away from the
  // live edge; cleared the moment the reader returns.
  const [newCount, setNewCount] = useState(0);
  const prevCount = useRef(messageCount);
  useLayoutEffect(() => {
    const grew = messageCount - prevCount.current;
    prevCount.current = messageCount;
    if (grew > 0 && !atEndRef.current) {
      setNewCount((n) => n + grew);
    }
    if (atEndRef.current) {
      scrollToBottom();
      setNewCount(0);
    }
    invalidate();
  }, [messageCount, atEndRef, invalidate, scrollToBottom]);

  useEffect(() => {
    if (!more && newCount !== 0) setNewCount(0);
  }, [more, newCount]);

  // A conversation switch lands at the live edge.
  useEffect(() => {
    scrollToBottom();
    atEndRef.current = true;
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
              intro && (
                <div className="px-4 pb-3 pt-4">
                  <div className="text-base font-semibold text-foreground">{intro.title}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-disabled">{intro.body}</p>
                </div>
              )
            )}

            {items.map((item) => (
              <Fragment key={item.key}>
                {item.kind === "group" && item.newDay && <DayDivider at={item.dayAt} />}
                {renderItem(item)}
              </Fragment>
            ))}

            {typingLabel && <TypingHint label={typingLabel} />}
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
