import { useEffect, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Hash, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { comms } from "../lib/comms-api";
import { CHANNEL_NAME_MAX, type ChatConversation } from "../types";
import { useCommsStore } from "../stores/comms-store";

/**
 * Rename a channel — `PATCH /conversations/{id} { name }`, open to any member
 * (an org admin too). Channels only: `kind` is immutable server-side and a
 * DM refuses a name outright, so no other conversation ever offers this.
 *
 * The response carries the whole updated conversation; adopting it paints
 * the header, tab label and home list at once, ahead of the org-wide
 * `conversation.updated` broadcast that keeps everyone else honest.
 */
export function RenameChannelMenu({
  conv,
  children,
}: {
  conv: ChatConversation;
  children: ReactNode;
}) {
  const actions = useCommsStore.use.actions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(conv.name ?? "");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setName(conv.name ?? "");
      setPending(false);
    }
  }, [open, conv.name]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending || trimmed === conv.name) {
      if (trimmed === conv.name) setOpen(false);
      return;
    }
    setPending(true);
    try {
      const updated = await comms.patchConversation(conv.id, { name: trimmed });
      setOpen(false);
      actions.adoptConversation(updated);
    } catch (e) {
      console.warn("comms: rename failed:", conv.id, e);
      toast.error(typeof e === "string" ? e : "Could not rename that channel.");
      setPending(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          style={{
            zIndex: 9999,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
          }}
          className="overflow-hidden rounded-xl select-none border border-white/10 bg-[var(--bg-elevated)]/95 backdrop-blur-2xl atlas-panel-in-tl"
        >
          <div className="flex w-[240px] flex-col">
            <div className="flex h-[32px] items-center gap-1.5 border-b border-white/5 px-3">
              <Hash size={11} className="shrink-0 text-text-tertiary" />
              <input
                autoFocus
                value={name}
                maxLength={CHANNEL_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                aria-label="Channel name"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>
            <div className="p-2">
              <button
                type="button"
                disabled={!name.trim() || pending}
                onClick={() => void save()}
                className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded-md bg-white/10 text-[11px] font-medium text-text-primary transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                {pending && <Loader2 size={11} className="animate-spin" />}
                Rename
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
