import { useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Loader2, Pin, Search } from "lucide-react";
import { timeAgo } from "@/lib/time-ago";
import { CommsAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
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

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) => {
      const body = p.message?.body?.toLowerCase() ?? "";
      const name = p.message ? (members.get(p.message.author_id)?.name?.toLowerCase() ?? "") : "";
      return body.includes(q) || name.includes(q);
    });
  }, [rows, query, members]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`${count} pinned`}
          className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <Pin size={10} />
          <span className="tabular-nums">{count}</span>
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
          className="overflow-hidden rounded-xl select-none border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl atlas-panel-in-tl"
        >
          <div className="flex max-h-[min(420px,60vh)] w-[320px] flex-col">
            <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-white/5 px-3">
              <Search size={11} className="shrink-0 text-text-tertiary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pins…"
                aria-label="Search pinned messages"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>

            <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
              {rows === null && (
                <div className="flex items-center justify-center gap-1.5 py-6 text-[11px] text-text-tertiary">
                  <Loader2 size={11} className="animate-spin" />
                  Loading pins…
                </div>
              )}
              {rows !== null && filtered.length === 0 && (
                <div className="py-6 text-center text-[11px] text-text-ghost">
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
                      "flex w-full cursor-pointer flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)]" +
                      (i === filtered.length - 1 ? "" : " border-b border-white/5")
                    }
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <CommsAvatar member={author} size={16} />
                      <span className="min-w-0 truncate text-[11px] font-medium text-text-primary">
                        {author?.name ?? "Unknown"}
                      </span>
                      <span className="ml-auto shrink-0 text-[9px] text-[var(--text-tertiary)]">
                        {timeAgo(new Date(pin.at).toISOString(), { suffix: true })}
                      </span>
                    </div>
                    <span className="line-clamp-2 pl-[22px] text-[11px] leading-snug text-text-secondary">
                      {msg?.body || (msg?.attachments?.length ? "(attachment)" : "…")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
