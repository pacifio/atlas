// Copy / retry, under a user message.
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
//  3. **The transcript is not virtualized** (`transcript.tsx:1`), so this
//     mounts once per user message for the life of the thread. That is why
//     the reveal is pure CSS `group-hover` against the row wrapper's existing
//     `group` class: a JS hover state would fire a `setState` for every bubble
//     the pointer crosses during a fast flick, which is precisely the work
//     the transcript is built to avoid. The trade is two buttons' worth of
//     idle DOM per user row, which costs nothing at scroll time.
//
// `focus-within` on the container is not decoration: with an opacity-only
// reveal, keyboard users would otherwise tab into controls they cannot see.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { retryLastTurn } from "../lib/retry-turn";

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-secondary)] cursor-pointer"
    >
      {children}
    </button>
  );
}

export function UserRowActions({
  tabId,
  text,
  canRetry,
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
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A row can unmount while the "copied" tick is still pending (window growth
  // and history loads both remount rows freely).
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

  return (
    <div
      className={cn(
        // `top-full`, not "under the bubble": the attachment chip and the
        // show-more toggle also sit below it, and anchoring to the bubble
        // would drop the bar on top of them.
        "absolute right-0 top-full z-[2] mt-px flex items-center gap-0.5",
        "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {canRetry && (
        <ActionButton label="Retry this message" onClick={onRetry}>
          <RotateCcw size={12} />
        </ActionButton>
      )}
      <ActionButton label={copied ? "Copied" : "Copy message"} onClick={onCopy}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </ActionButton>
    </div>
  );
}
