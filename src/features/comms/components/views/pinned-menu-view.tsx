import { useEffect, useMemo, useState } from "react";
import { Pin, Search } from "lucide-react";
import {
  Button,
  Hint,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@tryatlas/design";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { CommsAvatar, IntegrationAvatar } from "../comms-avatar";
import { authorLabel, isWebhookMessage, presentAuthor } from "../../lib/message-author";
import { toPlainText } from "../../lib/to-plain-text";
import type { ChatPin, OrgMemberProfile } from "../../types";

export interface PinnedMenuViewProps {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pins, or `null` while they load. */
  rows: ChatPin[] | null;
  members: Map<string, OrgMemberProfile>;
  onJump: (messageId: string) => void;
}

/**
 * The pin rail as a popover: a search row on top, scrollable rows, timeAgo
 * stamps.
 */
export function PinnedMenuView({
  count,
  open,
  onOpenChange,
  rows,
  members,
  onJump,
}: PinnedMenuViewProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Flattened once per list, NOT once per keystroke — the filter below runs on
  // every character typed, and searching the raw body meant a query could match
  // `**` markers and mention ids the reader never sees.
  const searchable = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of rows ?? []) {
      if (!p.message) continue;
      out.set(p.message.id, toPlainText(p.message.body, members).toLowerCase());
    }
    return out;
  }, [rows, members]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) => {
      const body = p.message ? (searchable.get(p.message.id) ?? "") : "";
      // An integration is found by the name it posted under, not by a
      // member lookup its `whk_…` id can never satisfy.
      const name = p.message
        ? authorLabel(p.message, (id) => members.get(id)?.name ?? "").toLowerCase()
        : "";
      return body.includes(q) || name.includes(q);
    });
  }, [rows, query, members, searchable]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Hint label={`${count} pinned`}>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="xs" aria-label={`${count} pinned`}>
              <Icon icon={Pin} size="xs" />
              <span className="tabular-nums">{count}</span>
            </Button>
          }
        />
      </Hint>
      <PopoverContent
        data-view="pinned-menu"
        align="end"
        sideOffset={6}
        className="flex max-h-[min(420px,60vh)] w-[320px] flex-col gap-0 p-0"
      >
        <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
          <Icon icon={Search} size="sm" className="text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pins…"
            aria-label="Search pinned messages"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
          {rows === null && (
            <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-muted-foreground">
              <Spinner size="xs" label="" />
              Loading pins…
            </div>
          )}
          {rows !== null && filtered.length === 0 && (
            <div className="py-6 text-center text-xs text-disabled">
              {rows.length === 0 ? "Nothing pinned yet." : "No pins match."}
            </div>
          )}
          {filtered.map((pin, i) => {
            const msg = pin.message;
            const author = msg ? (members.get(msg.author_id) ?? null) : null;
            return (
              <button
                key={pin.message_id}
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  if (msg) onJump(msg.id);
                }}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left transition-colors duration-fast hover:bg-element-hover",
                  i < filtered.length - 1 && "border-b border-border-subtle",
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  {msg && isWebhookMessage(msg) ? (
                    <IntegrationAvatar
                      id={msg.author_id}
                      name={presentAuthor(msg, () => "").name}
                      size={16}
                    />
                  ) : (
                    <CommsAvatar member={author} size={16} />
                  )}
                  <span className="min-w-0 truncate text-xs font-medium text-foreground">
                    {msg && isWebhookMessage(msg)
                      ? authorLabel(msg, () => "Unknown")
                      : (author?.name ?? "Unknown")}
                  </span>
                  <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                    {timeAgo(new Date(pin.at).toISOString(), { suffix: true })}
                  </span>
                </div>
                <span className="line-clamp-2 pl-[22px] text-xs leading-snug text-secondary-foreground">
                  {(msg && toPlainText(msg.body, members)) ||
                    (msg?.attachments?.length ? "(attachment)" : "…")}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
