import { useEffect, useRef, useState } from "react";
import { Check, Hash, Plus } from "lucide-react";
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
import { CHANNEL_NAME_MAX } from "../../types";

export interface CreateChannelMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The create call is in flight: the submit is disabled and spins. */
  pending: boolean;
  onCreate: (name: string, isPrivate: boolean) => void;
}

/**
 * The web app's inline "new-channel" input, as a popover off the section
 * header's `+`: a name row, a Private toggle, a full-width submit.
 *
 * Visibility is one extra row because the API charges nothing for it: a
 * `private` channel is invite-only and never announced org-wide. The name is
 * sent as typed (trimmed); the server owns the naming rules.
 */
export function CreateChannelMenuView({
  open,
  onOpenChange,
  pending,
  onCreate,
}: CreateChannelMenuViewProps) {
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setIsPrivate(false);
    }
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    onCreate(trimmed, isPrivate);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Hint label="New channel">
        <PopoverTrigger
          render={<IconButton icon={Plus} label="New channel" size="xs" variant="ghost" />}
        />
      </Hint>
      <PopoverContent
        data-view="create-channel-menu"
        align="end"
        sideOffset={6}
        initialFocus={inputRef}
        className="w-64 gap-0 p-0"
      >
        <div className="flex h-control-lg items-center gap-1.5 border-b border-border-subtle px-3">
          <Icon icon={Hash} size="sm" className="text-muted-foreground" />
          <input
            ref={inputRef}
            value={name}
            maxLength={CHANNEL_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
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
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-secondary-foreground transition-colors duration-fast hover:bg-element-hover"
        >
          <span
            className={cn(
              "flex h-[14px] w-[14px] items-center justify-center rounded border transition-colors duration-fast",
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
          <Button
            variant="secondary"
            size="sm"
            disabled={!name.trim() || pending}
            onClick={submit}
            className="w-full"
          >
            {pending && <Spinner size="xs" label="" />}
            Create channel
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
