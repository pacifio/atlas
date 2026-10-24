// The hover footer under a user message: timestamp, retry, copy, and a "…"
// menu holding edit-and-resend and pin. Which action sits where is decided by
// `lib/message-footer.ts`; this file only draws it. The agent's responses wear
// the same footer, mirrored to the left (`prose-row-actions.tsx`).
//
// The "Show more" toggle is NOT here — it lives in flow above this bar
// (`ExpandToggle` in `transcript-rows.tsx`) because it is the only signal that
// a bubble is truncated at all, and a hover-only truncation marker means a
// clamped prompt reads as a complete one.
//
// Three constraints shaped this, and each one rules out the obvious approach:
//
//  1. **House rule 1 — nothing grows on hover.** The bar cannot be in flow: a
//     row that gets taller on hover reflows every row below it, mid-scroll.
//     So it is absolutely positioned into the `pb-7` gap the user column
//     reserves between one exchange and the next, and reserves no space of
//     its own. `.atlas-row` sets `contain: layout style` and deliberately NOT
//     `paint` (`globals.css`), so the bar's own bottom padding is free to
//     overhang that gap without being clipped — 28px of `pb-7` holds the
//     4px top pad and the 24px buttons, which is everything that draws. That
//     gap is reserved whether or not the bar is showing, so revealing it can
//     never move anything.
//
//  2. **House rule 3 — rows never subscribe to a store.** The actions read
//     what they need through `getState()` at click time. Nothing here holds a
//     subscription, so nothing here re-renders on a streaming frame.
//
//  3. **The transcript is not virtualized** (`transcript.tsx:1`). It renders a
//     growing WINDOW — `rows.slice(safeStart)` — so this is mounted for every
//     user message currently inside it, and the window only ever grows as the
//     reader scrolls back. Rows are keyed by `row.id`, so growth prepends
//     without remounting what is already there. The DOM cost is a few buttons
//     per windowed user row, which is nothing at scroll time.
//
// # The reveal snaps. It does not animate.
//
// The bar is hidden until its row is hovered, via `group-hover` against the
// row wrapper's `group` class — a CSS hover, never a JS one. A JS hover state
// would fire a `setState` for every bubble the pointer crosses during a fast
// flick, which is precisely the work the transcript is built to avoid.
//
// What it must NOT do is transition. It used to fade in over 100ms, and a
// running opacity transition is a compositing layer in WebKit: rows passing
// under a resting pointer mid-fling each took one, several times a second, in
// the frames the tile deadline can least afford. An opacity that flips from 0
// to 1 in one frame has nothing to interpolate and never promotes anything. Do
// not reintroduce `transition-opacity`, a fade, or an enter delay here.
//
// Opacity, not `visibility`. The bar used `invisible`, and a
// `visibility: hidden` button is not focusable at all: Tab skipped every
// footer, so `focus-within` could never fire and the actions were mouse-only.
// At `opacity-0` the buttons stay in the tab order, and focusing one reveals
// the bar. `pointer-events-none` while hidden is what keeps a hidden bar from
// being clicked (the reason `visibility` was chosen in the first place).
//
// Two more ways the bar stays up without a pointer over it, both CSS: while
// one of its own popups is open (`has-aria-expanded`, set by the "…" menu's
// trigger and the comment button), since the menu portals out of the row and
// the pointer leaves it to reach an item; and on a coarse pointer, which has
// no hover to reveal it with.
//
// The hover itself is still not free: `group-hover:` compiles to
// `:is(:where(.group):hover *)`, so each row the pointer crosses invalidates
// style for its whole subtree. That is what the transcript's fling
// hover-suspension is for (`use-transcript-scroll.ts`, `data-scroll-hot`) —
// it makes the content inert for the duration of a gesture so none of this
// fires while scrolling. Keep the two together; neither is sufficient alone.
//
// # Why the copy button jittered
//
// The buttons carried Tailwind's `transition-colors`, which animates `fill`
// and `stroke` as well as `color` — so hovering an icon repainted its SVG
// every frame of the transition, the "icon jitter" the global rule at
// `globals.css` ("only background-color") exists to prevent. The buttons now
// inherit that rule and transition nothing else. Labels are also constant
// (`title` used to flip to "Copied", and macOS re-anchors the native tooltip
// when it changes under the pointer); the copied state rides on the icon.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyGlyph } from "@/ui/animated-icon";
import { CornerUpRight, MoreHorizontal, Pin, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { formatDayAwareTime, formatFullTimestamp } from "@/lib/format-time";
import { HintGroup, HintItem } from "@/ui/hint-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { retryLastTurn } from "../lib/retry-turn";
import { userFooterActions } from "../lib/message-footer";
import { useChatPinsStore } from "../stores/chat-pins-store";
import { ActionCluster } from "@/features/artifacts/components/action-cluster";
import { CommentButton } from "@/features/artifacts/components/comment-thread";
import { visibleCount } from "@/features/artifacts/lib/comments-api";
import {
  useAnchorHit,
  useThreadOpenSignal,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
} from "../stores/chat-comments-store";
import { useRowHasComments } from "./chat-comment-pills";

/**
 * One footer icon button: a 24px ghost square around a 12px glyph, filling on
 * hover. No `transition-colors` — see the jitter note above.
 */
function FooterButton({
  active,
  ...props
}: Omit<React.ComponentProps<"button">, "className"> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex size-control-sm items-center justify-center rounded-md cursor-pointer",
        "hover:bg-element-hover hover:text-foreground",
        // A menu trigger stays lit while its menu is open.
        "aria-expanded:bg-element-hover aria-expanded:text-foreground",
        active ? "text-primary" : "text-muted-foreground",
      )}
    />
  );
}

export function ActionButton({
  label,
  onClick,
  active,
  children,
}: {
  /** Constant for the lifetime of the button — see the jitter note. */
  label: string;
  onClick: () => void;
  /** Sticky "on" state (the pin). Hover styling still applies on top. */
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label}>
      <FooterButton onClick={onClick} aria-pressed={active} active={active}>
        {children}
      </FooterButton>
    </HintItem>
  );
}

/**
 * The pin, as one toggle that stays put: dim unpinned, lit and filled pinned.
 * The label never changes — `aria-pressed` carries the state, so a screen
 * reader hears "Pin message, toggle button, pressed" rather than an "Unpin"
 * label stacked on a pressed state. See `message-footer.ts` for why it never
 * moves between the bar and the menu.
 */
export function PinToggle({
  label,
  pinned,
  onToggle,
}: {
  label: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <ActionButton label={label} onClick={onToggle} active={pinned}>
      <Pin size={12} fill={pinned ? "currentColor" : "none"} />
    </ActionButton>
  );
}

/**
 * How a footer comes and goes. Hidden at rest, shown on row hover, on keyboard
 * focus inside it, while one of its popups is open, and always on a touch
 * screen. Snaps, never fades (the note at the top of this file).
 */
export const FOOTER_REVEAL = cn(
  "pointer-events-none opacity-0",
  "group-hover:pointer-events-auto group-hover:opacity-100",
  "focus-within:pointer-events-auto focus-within:opacity-100",
  "has-aria-expanded:pointer-events-auto has-aria-expanded:opacity-100",
  "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
);

/**
 * When the message was sent, short ("4:34 PM", "yesterday at 4:34 PM",
 * "10/22 4:34 PM") with the whole date in the tooltip.
 *
 * Not memoized: the formatters are cached (`format-time.ts`), so formatting
 * is a call, and a memo keyed on the timestamp would hold a stale label
 * across a 12h/24h switch or midnight on the renders that do happen.
 *
 * The full date is built only when the tooltip is about to open, on pointer
 * enter of the timestamp itself (the tooltip's open delay covers the extra
 * render). That state lives here, so it
 * re-renders this `<time>` and nothing else; the row never hears of it.
 * Until then the label is the short form, which is also a fine accessible
 * name for the element.
 */
export function MessageTimestamp({ timestamp }: { timestamp: string }) {
  const [full, setFull] = useState<string | null>(null);
  const short = formatDayAwareTime(timestamp);
  if (!short) return null;
  const prime = () => setFull(formatFullTimestamp(timestamp));
  return (
    <HintItem label={full ?? short}>
      <time
        dateTime={timestamp}
        onPointerEnter={prime}
        className="px-1 text-xs tabular-nums text-muted-foreground"
      >
        {short}
      </time>
    </HintItem>
  );
}

export interface FooterMenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

/** Keys that open a menu button, per the ARIA menu-button pattern. */
/**
 * The "…" menu for a footer's less frequent actions. Renders nothing when it
 * has no items, so a footer with nothing tucked away carries no empty menu.
 *
 * Mounted lazily. A `Menu.Root` costs several times a plain button (its
 * store, floating-tree context, trigger registration), and one sits on every
 * windowed prompt, almost none of which is ever opened. So at rest this is
 * the plain footer button; the first click (or Enter, Space, ArrowDown) swaps
 * in the real menu, already open — it is controlled, so that first press is
 * the one that opens it rather than a press that merely arms it. Once mounted it
 * stays mounted for the row's lifetime.
 *
 * The swap replaces the button element, so focus is handed to the new trigger
 * (`autoFocus`) — otherwise a keyboard open would leave focus on a node that
 * no longer exists, and closing the menu would return it to `<body>`.
 */
export function FooterMenu({
  items,
  align,
}: {
  items: FooterMenuItem[];
  /** The menu's edge that lines up with the button: the footer's outer side. */
  align: "start" | "end";
}) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  const icon = <MoreHorizontal size={12} />;
  if (!mounted) {
    const arm = () => {
      setMounted(true);
      setOpen(true);
    };
    return (
      <HintItem label="More actions">
        <FooterButton
          aria-haspopup="menu"
          aria-expanded={false}
          // `click`, not `pointerdown`: swapping the element mid-press left
          // the rest of the gesture (pointerup, click) to be delivered after
          // the menu mounted, and a pointer open never showed (checked
          // headless; the keyboard path was fine). A completed click has
          // nothing left to deliver. Enter and Space arrive here as a click.
          onClick={arm}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown") return;
            e.preventDefault();
            arm();
          }}
        >
          {icon}
        </FooterButton>
      </HintItem>
    );
  }

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <HintItem label="More actions">
        {/* Rendered as the footer's own button, so the trigger is the same
            24px ghost square as its neighbours rather than a restyled one. */}
        <DropdownMenuTrigger render={<FooterButton autoFocus />}>{icon}</DropdownMenuTrigger>
      </HintItem>
      <DropdownMenuContent align={align}>
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onClick={item.onSelect}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The copy action with its 1.2 s tick, shared by both bars. */
export function useCopy(text: string): { copied: boolean; onCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row can unmount while the "copied" tick is still pending — a history
  // load replaces the projection wholesale, and closing the tab takes the
  // transcript with it. (Window growth does not: `key={row.id}` keeps existing
  // instances alive when rows are prepended.)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const onCopy = useCallback(() => {
    void copyText(text).then((ok) => {
      // `copyText` returns false rather than throwing when both the native and
      // the web path fail. Swallowing that is indistinguishable from success —
      // the tick simply never appears and the user pastes stale clipboard
      // contents somewhere else before noticing.
      if (!ok) {
        toast.error("Could not copy to the clipboard");
        return;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_200);
    });
  }, [text]);
  return { copied, onCopy };
}

/**
 * Copy, with the comment pill beside it when the message is in the cloud.
 *
 * The two share one surround, as on the Timeline: the pill is how a
 * discussion announces itself, and a lone pill with a gap beside it reads as
 * something missing. Without a cloud anchor this is the plain copy button —
 * no surround around a single control.
 */
export function CommentAndCopy({
  tabId,
  messageId,
  text,
  label,
}: {
  tabId: string;
  messageId: string;
  text: string;
  label: string;
}) {
  const { copied, onCopy } = useCopy(text);
  const anchor = useAnchorHit(tabId, messageId);
  // The comments popup asked for this row's thread: open it.
  const openSignal = useThreadOpenSignal(tabId, anchor?.rowId);
  const comments = useCommentBucket(tabId, messageId);
  const commentActions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const copy = (
    <ActionButton label={label} onClick={onCopy}>
      <CopyGlyph copied={copied} size="sm" />
    </ActionButton>
  );
  if (!anchor || !commentActions || !directory) return copy;
  return (
    // The surround's OUTER edge is what the eye lines up with the bubble, so
    // the cluster sits flush with the bar's end and the icons inset inside
    // it. Pulling it out to keep the copy icon where it stands alone was
    // tried and read as the pill overhanging the bubble (measured headless:
    // the pill's border landed 4px past the bubble's edge).
    <ActionCluster reveal="snap" pinned={visibleCount(comments) > 0}>
      <CommentButton
        bare
        className="transition-none"
        openSignal={openSignal}
        anchorKind={anchor.anchorKind}
        anchorId={anchor.rowId}
        comments={comments}
        actions={commentActions}
        directory={directory}
      />
      {copy}
    </ActionCluster>
  );
}

export function UserRowActions({
  tabId,
  text,
  canRetry,
  messageId,
  timestamp,
  timestampApproximate = false,
  pinScopeKey,
  toggleAbove,
}: {
  tabId: string;
  /** The cleaned prompt — `row.text`, already stripped of injected context and
   *  the next-steps directive by `derivedUser`. Copying the wire text instead
   *  would hand the user kilobytes of repo context they never wrote. */
  text: string;
  /** Only the thread's last user message can be retried, and only where the
   *  agent can actually rewind. Resolved by the transcript so this stays a
   *  plain boolean prop — see `sessionCanRetry` in `retry-gate.ts`. */
  canRetry: boolean;
  /** `ChatMessage.id` — what a pin addresses. The row id is `u:<messageId>`;
   *  the pin stores the raw id so the header can resolve it to a message
   *  index for `atlas:chat-jump`. */
  messageId: string;
  /** The message's own timestamp — the durable half of a pin's key, since ids
   *  are re-minted on every history load (`resolvePinIndex`). */
  timestamp: string;
  /** The timestamp is only when Atlas replayed the message (an agent's
   *  history replay carries no time): the footer shows no clock. */
  timestampApproximate?: boolean;
  /** Pin scope for this thread, resolved by the transcript — see `pinScope`.
   *  Rows must not read the chat store themselves (house rule 3). */
  pinScopeKey: string;
  /** Is the "Show more" toggle rendered between the bubble and this bar? Then
   *  the gap is already there and this must not add a second one — see the
   *  padding below. The row passes the same measured `overflows` that gates
   *  the toggle, so the two can never disagree. */
  toggleAbove: boolean;
}) {
  // The one subscription a row is allowed. It is not the chat store: the pins
  // store is written only when someone clicks a pin, so this never fires on a
  // streaming frame, and the selector returns a boolean.
  const pinned = useChatPinsStore((s) =>
    (s.pins[pinScopeKey] ?? []).some((p) => p.messageId === messageId),
  );
  // The other permitted subscription: the comments store, written only when a
  // comment arrives or the session's cloud identity resolves — never on a
  // streaming frame. A boolean, so the bar re-renders only when it flips.
  const discussed = useRowHasComments(tabId, messageId);

  const onRetry = useCallback(() => void retryLastTurn(tabId), [tabId]);

  // Edit is NOT retry. Retry rewinds the turn off the agent and re-runs it
  // (destructive, native-agent-only). ACP has no verb to forget or rewrite a
  // turn (see `retry-gate.ts`), so editing in place is impossible there; the
  // honest version every agent supports is to load the prompt back into the
  // composer and let it go out as a NEW turn, the old exchange left intact.
  // Sending unchanged is one Enter away, which is what the old blind "Send
  // this prompt again" button did. The composer owns the draft, so this goes
  // through its tab-scoped `atlas:chat-prefill` seam.
  const onEdit = useCallback(() => {
    window.dispatchEvent(new CustomEvent("atlas:chat-prefill", { detail: { text, tabId } }));
  }, [text, tabId]);

  const onPin = useCallback(() => {
    useChatPinsStore.getState().actions.toggle(pinScopeKey, {
      messageId,
      timestamp,
      text,
      at: new Date().toISOString(),
    });
  }, [pinScopeKey, messageId, timestamp, text]);

  const actions = useMemo(() => userFooterActions({ canRetry }), [canRetry]);
  const menuItems = useMemo(
    () =>
      actions.overflow.map((): FooterMenuItem =>
        // A turn-out arrow, not a pencil. Nothing is edited in place: the
        // prompt goes back to the composer and leaves as a NEW turn.
        ({ label: "Edit and send as new message", icon: <CornerUpRight />, onSelect: onEdit }),
      ),
    [actions, onEdit],
  );

  return (
    <HintGroup>
      <div
        className={cn(
          // `top-full`, not "under the bubble": the attachment chip sits below
          // the bubble too, and anchoring to the bubble would drop the bar on
          // top of it.
          // `w-max`: the bar is wider than a short bubble, and an absolutely
          // positioned box with `right: 0` and no width is shrink-to-fit
          // against its containing block — WebKit clamped it to the bubble's
          // 95px and let the controls overflow to the right (measured in the
          // running app: pill 14px past the bubble). Max-content sizes the box
          // to its controls, so `right-0` puts the last one on the bubble's
          // edge and the rest extend left.
          "absolute right-0 top-full z-popover flex w-max items-center gap-2",
          // The gap above the buttons, as padding rather than a margin so the
          // bar's box still starts exactly at `top-full`.
          //
          // A bubble with a "Show more" toggle already has that gap: the toggle
          // is in flow between the bubble and this bar, so `top-full` is below
          // IT, and a top pad here would stack on top of the toggle's own
          // height — the icons visibly sat further from a clamped bubble than
          // from a short one. Longhands in both branches, never `py-1` plus a
          // `pt-0` override: shorthand-vs-longhand precedence is decided by
          // stylesheet order, which is not something to bet spacing on.
          toggleAbove ? "pt-0 pb-1" : "pt-1 pb-1",
          // A discussed prompt keeps its bar: the pill is how the discussion
          // announces itself, and it must not vanish with the pointer.
          discussed ? "visible" : FOOTER_REVEAL,
        )}
      >
        {!timestampApproximate && <MessageTimestamp timestamp={timestamp} />}
        <div className="flex items-center gap-0.5">
          {actions.inline.map((action) =>
            action === "retry" ? (
              <ActionButton key={action} label="Retry (replaces this response)" onClick={onRetry}>
                <RefreshCw size={12} />
              </ActionButton>
            ) : action === "pin" ? (
              <PinToggle key={action} label="Pin message" pinned={pinned} onToggle={onPin} />
            ) : (
              <CommentAndCopy
                key={action}
                tabId={tabId}
                messageId={messageId}
                text={text}
                label="Copy message"
              />
            ),
          )}
          <FooterMenu items={menuItems} align="end" />
        </div>
      </div>
    </HintGroup>
  );
}
