import { useEffect, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { CommsAvatar } from "./comms-avatar";
import { comms } from "../lib/comms-api";
import { useCommsStore } from "../stores/comms-store";

/** The server takes up to 9 OTHERS in a group DM (3–10 people with you). */
const MAX_OTHERS = 9;

/**
 * "Pick one person for a DM, or more for a group DM" — the web flow, as a
 * multi-select picker off the section header's `+` (search row + rows +
 * check marks, the checkpoints-picker idiom).
 *
 * One selection goes through `createDm`, which is idempotent — picking
 * somebody you already talk to opens the existing thread. Two-plus goes
 * through `createGroupDm`, which deliberately is NOT: membership is frozen
 * at creation, so every group starts fresh with no history to leak.
 */
export function NewDmMenu() {
  const memberList = useCommsStore.use.members();
  const me = useCommsStore.use.me();
  const actions = useCommsStore.use.actions();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setPicked(new Set());
      setPending(false);
    }
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memberList
      .filter((m) => m.id !== me)
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [memberList, me, query]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_OTHERS) next.add(id);
      return next;
    });
  };

  const start = async () => {
    const ids = [...picked];
    if (ids.length === 0 || pending) return;
    setPending(true);
    try {
      const conversation =
        ids.length === 1
          ? (await comms.createDm(ids[0])).conversation
          : await comms.createGroupDm(ids);
      setOpen(false);
      actions.adoptConversation(conversation);
      actions.openConversation(conversation.id);
    } catch (e) {
      console.warn("comms: start conversation failed:", e);
      toast.error(typeof e === "string" ? e : "Could not start that conversation.");
      setPending(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint label="New message">
        <Popover.Trigger
          render={
            <button
              type="button"
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground cursor-pointer"
            >
              <Plus size={11} />
            </button>
          }
        />
      </Hint>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="overflow-hidden rounded-xl select-none border border-border bg-[var(--card)]/95 backdrop-blur-2xl atlas-panel-in-tl shadow-lg inset-highlight">
            <div className="flex max-h-[min(380px,55vh)] w-[260px] flex-col">
              <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
                <Search size={11} className="shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people…"
                  aria-label="Search people"
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
                {candidates.length === 0 && (
                  <div className="py-5 text-center text-xs text-disabled">
                    {memberList.length <= 1 ? "Nobody else is here yet." : "Nobody matches."}
                  </div>
                )}
                {candidates.map((m) => {
                  const selected = picked.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="flex w-full items-center gap-2 px-3 py-[5px] text-left transition-colors hover:bg-element-hover cursor-pointer"
                    >
                      <CommsAvatar member={m} size={20} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-foreground">{m.name}</span>
                        <span className="block truncate text-2xs text-disabled">{m.email}</span>
                      </span>
                      <Check
                        size={12}
                        className={cn(
                          "shrink-0 transition-opacity",
                          selected ? "text-foreground opacity-100" : "opacity-0",
                        )}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="shrink-0 border-t border-border-subtle p-2">
                <button
                  type="button"
                  disabled={picked.size === 0 || pending}
                  onClick={() => void start()}
                  className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded-md bg-element-active text-xs font-medium text-foreground transition-colors hover:bg-[var(--element-emphasis)] disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                >
                  {pending && <Loader2 size={11} className="animate-spin" />}
                  Message
                </button>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
