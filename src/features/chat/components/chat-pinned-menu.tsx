// Pinned messages for a session, as a title-bar dropdown.
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
// The jump itself is the panel's (`onJump`): it resolves the pin against the
// session's messages, which only the panel holds.
//
// The trigger renders only when something is pinned. An always-present pin
// button with a zero next to it is a control that asks to be ignored.

import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Pin, PinOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { Button } from "@/ui/button";
import { HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { pinsFor, useChatPinsStore, type ChatPin } from "../stores/chat-pins-store";

export function ChatPinnedMenu({
  pinScopeKey,
  onJump,
}: {
  pinScopeKey: string;
  onJump: (pin: ChatPin) => void;
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
      <HintItem label="Pinned messages">
        <Popover.Trigger
          render={
            <Button variant="ghost" size="sm" aria-label={`${pins.length} pinned messages`}>
              <Pin size={12} />
              <span className="tabular-nums">{pins.length}</span>
            </Button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="overflow-hidden rounded-xl select-none inset-highlight shadow-md border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl atlas-panel-in-tl">
            <div className="flex max-h-[min(420px,60vh)] w-[320px] flex-col">
              <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-[var(--atlas-element-hover)] px-3">
                <Search size={11} className="shrink-0 text-[var(--muted-foreground)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search pins…"
                  aria-label="Search pinned messages"
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                />
              </div>

              <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
                {filtered.length === 0 && (
                  <div className="py-6 text-center text-xs text-[var(--atlas-text-disabled)]">
                    No pins match.
                  </div>
                )}
                {filtered.map((pin, i) => (
                  <div
                    key={pin.messageId}
                    className={cn(
                      "group/pin flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-[var(--atlas-element-hover)]",
                      i === filtered.length - 1
                        ? ""
                        : "border-b border-[var(--atlas-element-hover)]",
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
                      <span className="line-clamp-2 text-xs leading-snug text-[var(--secondary-foreground)]">
                        {pin.text || "…"}
                      </span>
                      <span className="text-3xs text-[var(--muted-foreground)]">
                        Pinned {timeAgo(pin.at, { suffix: true })}
                      </span>
                    </button>
                    <Hint label="Unpin">
                      <button
                        type="button"
                        aria-label="Unpin message"
                        onClick={() =>
                          useChatPinsStore.getState().actions.unpin(pinScopeKey, pin.messageId)
                        }
                        className="mt-px flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--foreground)] group-hover/pin:opacity-100 focus-visible:opacity-100"
                      >
                        <PinOff size={11} />
                      </button>
                    </Hint>
                  </div>
                ))}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
