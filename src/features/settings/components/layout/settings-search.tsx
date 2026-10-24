import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Icon } from "@/ui/icon";
import { IconButton } from "@/ui/icon-button";

/**
 * The search field a settings page puts over a long list (API keys, skills),
 * drawn like the Keybindings one. Escape clears it before it closes anything.
 */
export function SettingsSearch({
  value,
  onValueChange,
  placeholder,
  label,
  trailing,
}: {
  value: string;
  onValueChange: (next: string) => void;
  placeholder: string;
  /** Accessible name for the field. */
  label: string;
  /** Shown before the clear button: a spinner while results load. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-control-md min-w-60 flex-1 items-center gap-1.5 rounded-md border border-border bg-panel-input pr-0.5 pl-2 transition-colors duration-fast ease-out-strong focus-within:border-border-strong">
      <Icon icon={Search} size="xs" className="text-muted-foreground" />
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onValueChange("");
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      {trailing}
      {value && (
        <IconButton icon={X} size="xs" label="Clear search" onClick={() => onValueChange("")} />
      )}
    </div>
  );
}
