// Pinned messages for an agent chat, as a header dropdown.
//
// The comms pin rail's recipe, applied to the agent thread: one element
// carrying border + fill + backdrop blur + the panel-in animation (splitting
// those across elements kills the blur — see `chat-header.tsx`), rows with a
// preview and a `timeAgo` stamp, and a click that jumps the transcript.
//
// Two differences from comms, both because these pins are local (see
// `chat-pins-store.ts`): the rows come from the store rather than a REST call,
// so there is no loading state; and the pinned TEXT is stored with the pin, so
// a pin whose message has been rewound off the thread still renders.
//
// The jump itself is the panel's (`onJump`): it has to clear the role filter
// first and resolve the pin against the UNFILTERED list, and only the panel
// owns both.
//
// The trigger renders only when something is pinned. An always-present pin
// button with a zero next to it is a control that asks to be ignored.

import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Pin, PinOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { pinsFor, useChatPinsStore, type ChatPin } from "../stores/chat-pins-store";

export function ChatPinnedMenu({
  pinScopeKey,
  onJump,
  className,
}: {
  pinScopeKey: string;
  onJump: (pin: ChatPin) => void;
  /** The header's shared control treatment — one height, one border. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pins = useChatPinsStore((s) => pinsFor(s, pinScopeKey));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pins;
    return pins.filter((p) => p.text.toLowerCase().includes(q));
  }, [pins, query]);

  if (pins.length === 0) return null;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`${pins.length} pinned`}
          aria-label={`${pins.length} pinned messages`}
          className={className}
        >
          <Pin size={12} />
          <span className="tabular-nums text-[11px] leading-none">{pins.length}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          style={{
            zIndex: 9999,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
          }}
          className="overflow-hidden rounded-xl select-none border border-white/10 bg-[var(--bg-elevated)]/95 backdrop-blur-2xl atlas-panel-in-tl"
        >
          <div className="flex max-h-[min(420px,60vh)] w-[320px] flex-col">
            <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-white/5 px-3">
              <Search size={11} className="shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pins…"
                aria-label="Search pinned messages"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>

            <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <div className="py-6 text-center text-[11px] text-[var(--text-ghost)]">
                  No pins match.
                </div>
              )}
              {filtered.map((pin, i) => (
                <div
                  key={pin.messageId}
                  className={cn(
                    "group/pin flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-[var(--bg-hover)]",
                    i === filtered.length - 1 ? "" : "border-b border-white/5",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onJump(pin);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-left"
                  >
                    <span className="line-clamp-2 text-[11px] leading-snug text-[var(--text-secondary)]">
                      {pin.text || "…"}
                    </span>
                    <span className="text-[9px] text-[var(--text-tertiary)]">
                      Pinned {timeAgo(pin.at, { suffix: true })}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Unpin"
                    aria-label="Unpin message"
                    onClick={() =>
                      useChatPinsStore.getState().actions.unpin(pinScopeKey, pin.messageId)
                    }
                    className="mt-px flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-tertiary)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover/pin:opacity-100 focus-visible:opacity-100"
                  >
                    <PinOff size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
