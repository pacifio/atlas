import { useEffect, useRef, useState, type ReactElement } from "react";
import { Hash } from "lucide-react";
import { Button, Icon, Popover, PopoverContent, PopoverTrigger, Spinner } from "@tryatlas/design";
import { CHANNEL_NAME_MAX } from "../../types";

export interface RenameChannelMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel's current name; the field starts from it on every open. */
  initialName: string;
  pending: boolean;
  /** Called with the trimmed new name. An unchanged name never gets here —
   *  saving it just closes the popover. */
  onSave: (name: string) => void;
  /** The header element that opens the popover. */
  trigger: ReactElement;
}

/** Rename a channel: the name, selected on open, and a full-width submit. */
export function RenameChannelMenuView({
  open,
  onOpenChange,
  initialName,
  pending,
  onSave,
  trigger,
}: RenameChannelMenuViewProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || pending || trimmed === initialName) {
      if (trimmed && trimmed === initialName) onOpenChange(false);
      return;
    }
    onSave(trimmed);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        data-view="rename-channel-menu"
        align="start"
        sideOffset={6}
        initialFocus={inputRef}
        className="w-[240px] gap-0 p-0"
      >
        <div className="flex h-control-lg items-center gap-1.5 border-b border-border-subtle px-3">
          <Icon icon={Hash} size="sm" className="text-muted-foreground" />
          <input
            ref={inputRef}
            value={name}
            maxLength={CHANNEL_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            aria-label="Channel name"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="p-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!name.trim() || pending}
            onClick={save}
            className="w-full"
          >
            {pending && <Spinner size="xs" label="" />}
            Rename
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
