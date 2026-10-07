import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Loader2, Pin, Search } from "lucide-react";
import { timeAgo } from "@/lib/time-ago";
import { Hint } from "@/ui/tooltip";
import { CommsAvatar, IntegrationAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
import { authorLabel, isWebhookMessage, presentAuthor } from "../lib/message-author";
import { toPlainText } from "../lib/to-plain-text";
import type { ChatPin, OrgMemberProfile } from "../types";

/**
 * The pin rail as a dropdown — the agent chat's session-picker recipe: one
 * element carrying border + fill + backdrop blur + the panel-in animation
 * (splitting those across elements kills the blur, per chat-header.tsx), a
 * search row on top, scrollable rows, timeAgo stamps.
 *
 * Rows come from `comms_pins` fresh on every open, not from the store: the
 * store holds pinned *ids* only, and a pin can point far outside the loaded
 * message window — the REST rail carries each message riding with its pin.
 */
export function PinnedMenu({
  convId,
  count,
  members,
  onJump,
}: {
  convId: string;
  count: number;
  members: Map<string, OrgMemberProfile>;
  onJump: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ChatPin[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows(null);
    setQuery("");
    comms
      .pins(convId)
      .then((pins) => {
        if (live) setRows(pins);
      })
      .catch((e) => {
        console.warn("comms: pins fetch failed:", convId, e);
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [open, convId]);

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
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint label={`${count} pinned`}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className="flex h-5 items-center gap-1 rounded px-1.5 text-2xs text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
            >
              <Pin size={10} />
              <span className="tabular-nums">{count}</span>
            </button>
          }
        />
      </Hint>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="overflow-hidden rounded-xl select-none border border-border bg-[var(--card)]/95 backdrop-blur-2xl atlas-panel-in-tl shadow-lg inset-highlight">
            <div className="flex max-h-[min(420px,60vh)] w-[320px] flex-col">
              <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
                <Search size={11} className="shrink-0 text-muted-foreground" />
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
                    <Loader2 size={11} className="animate-spin" />
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
                        setOpen(false);
                        if (msg) onJump(msg.id);
                      }}
                      className={
                        "flex w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-[var(--atlas-element-hover)]" +
                        (i === filtered.length - 1 ? "" : " border-b border-border-subtle")
                      }
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
                        <span className="ml-auto shrink-0 text-3xs text-[var(--muted-foreground)]">
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
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
