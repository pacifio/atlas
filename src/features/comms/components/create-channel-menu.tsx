import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Hash, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { comms } from "../lib/comms-api";
import { CHANNEL_NAME_MAX } from "../types";
import { useCommsStore } from "../stores/comms-store";

/**
 * The web app's inline "new-channel" input, as a dropdown off the section
 * header's `+`. Same panel recipe as the pinned menu: one element carrying
 * border + fill + blur + the panel-in animation.
 *
 * Visibility is one extra row because the API charges nothing for it: a
 * `private` channel is invite-only and never announced org-wide.
 */
export function CreateChannelMenu() {
  const actions = useCommsStore.use.actions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setIsPrivate(false);
      setPending(false);
    }
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      const conversation = await comms.createChannel(trimmed, isPrivate ? "private" : undefined);
      setOpen(false);
      // Don't wait for the org-wide broadcast round trip to render our own act.
      actions.adoptConversation(conversation);
      actions.openConversation(conversation.id);
    } catch (e) {
      console.warn("comms: create channel failed:", e);
      toast.error(typeof e === "string" ? e : "Could not create that channel.");
      setPending(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="New channel"
          className="flex h-4 w-4 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <Plus size={11} />
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
          <div className="flex w-[240px] flex-col">
            <div className="flex h-[32px] items-center gap-1.5 border-b border-white/5 px-3">
              <Hash size={11} className="shrink-0 text-text-tertiary" />
              <input
                ref={inputRef}
                autoFocus
                value={name}
                maxLength={CHANNEL_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void create();
                  }
                }}
                placeholder="new-channel"
                aria-label="Channel name"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>

            <button
              type="button"
              onClick={() => setIsPrivate((v) => !v)}
              className="flex items-center gap-2 px-3 py-2 text-left text-[11px] text-text-secondary transition-colors hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <span
                className={cn(
                  "flex h-[14px] w-[14px] items-center justify-center rounded border transition-colors",
                  isPrivate
                    ? "border-white/40 bg-white/15 text-text-primary"
                    : "border-border-default text-transparent",
                )}
              >
                <Check size={10} />
              </span>
              Private
              <span className="ml-auto text-[9.5px] text-text-ghost">invite-only</span>
            </button>

            <div className="border-t border-white/5 p-2">
              <button
                type="button"
                disabled={!name.trim() || pending}
                onClick={() => void create()}
                className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded-md bg-white/10 text-[11px] font-medium text-text-primary transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                {pending && <Loader2 size={11} className="animate-spin" />}
                Create channel
              </button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
