import { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Hash, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { comms } from "../lib/comms-api";
import { CHANNEL_NAME_MAX } from "../types";
import { useCommsStore } from "../stores/comms-store";
import { Hint } from "@tryatlas/design";

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
      <Hint label="New channel">
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
            <div className="flex w-[240px] flex-col">
              <div className="flex h-[32px] items-center gap-1.5 border-b border-border-subtle px-3">
                <Hash size={11} className="shrink-0 text-muted-foreground" />
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
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>

              <button
                type="button"
                onClick={() => setIsPrivate((v) => !v)}
                className="flex items-center gap-2 px-3 py-2 text-left text-xs text-secondary-foreground transition-colors hover:bg-element-hover cursor-pointer"
              >
                <span
                  className={cn(
                    "flex h-[14px] w-[14px] items-center justify-center rounded border transition-colors",
                    isPrivate
                      ? "border-border-strong bg-[var(--element-emphasis)] text-foreground"
                      : "border-border text-transparent",
                  )}
                >
                  <Check size={10} />
                </span>
                Private
                <span className="ml-auto text-2xs text-disabled">invite-only</span>
              </button>

              <div className="border-t border-border-subtle p-2">
                <button
                  type="button"
                  disabled={!name.trim() || pending}
                  onClick={() => void create()}
                  className="flex h-[26px] w-full items-center justify-center gap-1.5 rounded-md bg-element-active text-xs font-medium text-foreground transition-colors hover:bg-[var(--element-emphasis)] disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                >
                  {pending && <Loader2 size={11} className="animate-spin" />}
                  Create channel
                </button>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
