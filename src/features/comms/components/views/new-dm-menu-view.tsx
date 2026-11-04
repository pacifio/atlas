import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import {
  Button,
  Hint,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { CommsAvatar } from "../comms-avatar";
import type { OrgMemberProfile } from "../../types";

/** The server takes up to 9 OTHERS in a group DM (3–10 people with you). */
export const MAX_OTHERS = 9;

export interface NewDmMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  /** Everyone but you, already sorted. */
  candidates: OrgMemberProfile[];
  /** The whole roster, you included — tells "nobody here" from "nobody matches". */
  totalMembers: number;
  onStart: (ids: string[]) => void;
}

/**
 * "Pick one person for a DM, or more for a group DM" — the web flow, as a
 * multi-select picker off the section header's `+` (search row + rows +
 * check marks, the checkpoints-picker idiom).
 */
export function NewDmMenuView({
  open,
  onOpenChange,
  pending,
  candidates,
  totalMembers,
  onStart,
}: NewDmMenuViewProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setPicked(new Set());
    }
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_OTHERS) next.add(id);
      return next;
    });
  };

  const start = () => {
    if (picked.size === 0 || pending) return;
    onStart([...picked]);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Hint label="New message">
        <PopoverTrigger
          render={<IconButton icon={Plus} label="New message" size="xs" variant="ghost" />}
        />
      </Hint>
      <PopoverContent
        data-view="new-dm-menu"
        align="end"
        sideOffset={6}
        initialFocus={searchRef}
        className="flex max-h-[min(380px,55vh)] w-[260px] flex-col gap-0 p-0"
      >
        <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
          <Icon icon={Search} size="sm" className="text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            aria-label="Search people"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
          {shown.length === 0 && (
            <div className="py-5 text-center text-xs text-disabled">
              {totalMembers <= 1 ? "Nobody else is here yet." : "Nobody matches."}
            </div>
          )}
          {shown.map((m) => {
            const selected = picked.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-[5px] text-left transition-colors duration-fast hover:bg-element-hover"
              >
                <CommsAvatar member={m} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{m.name}</span>
                  <span className="block truncate text-2xs text-disabled">{m.email}</span>
                </span>
                <span
                  className={cn(
                    "flex shrink-0 transition-opacity duration-fast",
                    selected ? "text-foreground opacity-100" : "opacity-0",
                  )}
                >
                  <Icon icon={Check} size="sm" />
                </span>
              </button>
            );
          })}
        </div>

        <div className="shrink-0 border-t border-border-subtle p-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={picked.size === 0 || pending}
            onClick={start}
            className="w-full"
          >
            {pending && <Spinner size="xs" label="" />}
            Message
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
