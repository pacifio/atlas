// Rewind / pin / resend / copy, under a user message.
//
// Three constraints shaped this, and each one rules out the obvious approach:
//
//  1. **House rule 1 — nothing grows on hover.** The bar cannot be in flow: a
//     row that gets taller on hover reflows every row below it, mid-scroll.
//     So it is absolutely positioned into the `pb-5` gap the user column
//     already reserves between one exchange and the next, and reserves no
//     space of its own. `.atlas-row` sets `contain: layout style` and
//     deliberately NOT `paint` (`globals.css:1660`), so the bar is free to
//     overhang that gap by a pixel or two without being clipped.
//
//  2. **House rule 3 — rows never subscribe to a store.** The actions read
//     what they need through `getState()` at click time. Nothing here holds a
//     subscription, so nothing here re-renders on a streaming frame.
//
//  3. **The transcript is not virtualized** (`transcript.tsx:1`). It renders a
//     growing WINDOW — `rows.slice(safeStart)` — so this is mounted for every
//     user message currently inside it, and the window only ever grows as the
//     reader scrolls back. Rows are keyed by `row.id`, so growth prepends
//     without remounting what is already there. That is why the reveal is
//     pure CSS `group-hover` against the row wrapper's existing `group`
//     class: a JS hover state would fire a `setState` for every bubble the
//     pointer crosses during a fast flick, which is precisely the work the
//     transcript is built to avoid. The trade is two buttons' worth of idle
//     DOM per windowed user row, which costs nothing at scroll time.
//
// `focus-within` on the container is not decoration: with an opacity-only
// reveal, keyboard users would otherwise tab into controls they cannot see.
//
// # Why the copy button jittered, and the scroll cost that came with it
//
// The buttons carried Tailwind's `transition-colors`, which animates `fill`
// and `stroke` as well as `color` — so hovering an icon repainted its SVG
// every frame of the transition, the "icon jitter" the global rule at
// `globals.css` ("only background-color") exists to prevent. The buttons now
// inherit that rule and transition nothing else. Labels are also constant
// (`title` used to flip to "Copied", and macOS re-anchors the native tooltip
// when it changes under the pointer); the copied state rides on the icon.
//
// The reveal is opacity ONLY and SHORT. Never a transform: the bar sits at
// `top-full` of a wrapper whose height is the bubble's, so a `translate-y`
// puts it inside the bubble. And no enter delay or long fade: a running
// opacity transition is a compositing layer in WebKit, and a longer one means
// more rows holding a layer at once as they pass under the pointer mid-fling.
// The transcript also suspends hover entirely while scrolling
// (`use-transcript-scroll.ts`), so the transition only ever runs on a still
// thread.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Forward, Pin, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { retryLastTurn } from "../lib/retry-turn";
import { useChatPinsStore } from "../stores/chat-pins-store";

function ActionButton({
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
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded-md cursor-pointer",
        "hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]",
        active ? "text-[var(--accent-primary)]" : "text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </button>
  );
}

export function UserRowActions({
  tabId,
  text,
  canRetry,
  messageId,
  timestamp,
  pinScopeKey,
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
  /** Pin scope for this thread, resolved by the transcript — see `pinScope`.
   *  Rows must not read the chat store themselves (house rule 3). */
  pinScopeKey: string;
}) {
  const [copied, setCopied] = useState(false);
  // The one subscription a row is allowed. It is not the chat store: the pins
  // store is written only when someone clicks a pin, so this never fires on a
  // streaming frame, and the selector returns a boolean.
  const pinned = useChatPinsStore((s) =>
    (s.pins[pinScopeKey] ?? []).some((p) => p.messageId === messageId),
  );
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

  const onRetry = useCallback(() => void retryLastTurn(tabId), [tabId]);

  // Resend is NOT retry. Retry rewinds the turn off the agent and re-runs it
  // (destructive, native-agent-only); resend leaves the thread alone and asks
  // the same question again as a new turn, which every agent can do. It goes
  // through the panel's `atlas:chat-send` seam rather than calling the agent
  // directly so it inherits the composer's whole send path — binding waits,
  // the queued-send chip while a turn is live, logging.
  const onResend = useCallback(() => {
    window.dispatchEvent(new CustomEvent("atlas:chat-send", { detail: { text, tabId } }));
  }, [text, tabId]);

  const onPin = useCallback(() => {
    useChatPinsStore.getState().actions.toggle(pinScopeKey, {
      messageId,
      timestamp,
      text,
      at: new Date().toISOString(),
    });
  }, [pinScopeKey, messageId, timestamp, text]);

  return (
    <div
      className={cn(
        // `top-full`, not "under the bubble": the attachment chip and the
        // show-more toggle also sit below it, and anchoring to the bubble
        // would drop the bar on top of them.
        "absolute right-0 top-full z-[2] mt-px flex items-center gap-0.5",
        "opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {canRetry && (
        <ActionButton label="Retry this message" onClick={onRetry}>
          <RotateCcw size={12} />
        </ActionButton>
      )}
      <ActionButton label="Pin message" onClick={onPin} active={pinned}>
        <Pin size={12} fill={pinned ? "currentColor" : "none"} />
      </ActionButton>
      <ActionButton label="Send this prompt again" onClick={onResend}>
        <Forward size={12} />
      </ActionButton>
      <ActionButton label="Copy message" onClick={onCopy}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </ActionButton>
    </div>
  );
}
