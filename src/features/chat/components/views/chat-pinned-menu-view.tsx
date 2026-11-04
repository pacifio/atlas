// Pinned messages for a session, as a title-bar dropdown.
//
// The comms pin rail's recipe, applied to the agent session: rows with a
// preview and a `timeAgo` stamp, and a click that jumps the transcript.
//
// Two differences from comms, both because these pins are local (see
// `chat-pins-store.ts`): the rows come from the store rather than a REST call,
// so there is no loading state; and the pinned TEXT is stored with the pin, so
// a pin whose message has been rewound off the session still renders.
//
// The jump itself is the panel's (`onJump`): it resolves the pin against the
// session's messages, which only the panel holds.
//
// The trigger renders only when something is pinned. An always-present pin
// button with a zero next to it is a control that asks to be ignored.

import { useMemo, useState } from "react";
import { Pin, PinOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import {
  Button,
  Hint,
  HintItem,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tryatlas/design";

/** What a row needs of a pin (`ChatPin` in `chat-pins-store.ts`). */
export interface PinnedRow {
  messageId: string;
  /** The pinned message's text, the row's preview. */
  text: string;
  /** When it was pinned. */
  at: string;
}

export function ChatPinnedMenuView<P extends PinnedRow>({
  pins,
  onJump,
  onUnpin,
}: {
  pins: P[];
  onJump: (pin: P) => void;
  onUnpin: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pins;
    return pins.filter((p) => p.text.toLowerCase().includes(q));
  }, [pins, query]);

  if (pins.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setQuery("");
      }}
    >
      <HintItem label="Pinned messages">
        <PopoverTrigger
          render={
            <Button variant="ghost" size="sm" aria-label={`${pins.length} pinned messages`}>
              <Icon icon={Pin} size="sm" />
              <span className="tabular-nums">{pins.length}</span>
            </Button>
          }
        />
      </HintItem>
      <PopoverContent align="end" sideOffset={6} className="w-[320px] p-0">
        <div className="flex max-h-[min(420px,60vh)] flex-col select-none">
          <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
            <Icon icon={Search} size="xs" className="shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pins…"
              aria-label="Search pinned messages"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="py-6 text-center text-xs text-disabled">No pins match.</div>
            )}
            {filtered.map((pin, i) => (
              <div
                key={pin.messageId}
                className={cn(
                  "group/pin flex items-start gap-2 px-3 py-2.5 transition-colors hover:bg-element-hover",
                  i < filtered.length - 1 && "border-b border-border-subtle",
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
                  <span className="line-clamp-2 text-xs leading-snug text-secondary-foreground">
                    {pin.text || "…"}
                  </span>
                  <span className="text-3xs text-muted-foreground">
                    Pinned {timeAgo(pin.at, { suffix: true })}
                  </span>
                </button>
                {/* Revealed with its row, or as focus reaches it. */}
                <span className="flex opacity-0 transition-opacity group-hover/pin:opacity-100 focus-within:opacity-100">
                  <Hint label="Unpin">
                    <IconButton
                      variant="ghost"
                      size="xs"
                      icon={PinOff}
                      label="Unpin message"
                      // Named here too: Hint names an unnamed trigger after its own label.
                      aria-label="Unpin message"
                      onClick={() => onUnpin(pin.messageId)}
                    />
                  </Hint>
                </span>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
