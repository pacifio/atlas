// A round icon button with the footer dock's glass rim (`glass-rim`): the
// sidebar's standalone actions — Add project beside the picker, New session
// beside the search — drawn as small capsules of the same glass as the dock.

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon, Hint } from "@tryatlas/design";

export function GlassIconButton({
  icon,
  label,
  shortcut,
  disabled,
  pressed,
  onClick,
  className,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** A toggle's on state: the lifted fill (`glass-rim-control`). */
  pressed?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Hint label={label} shortcut={shortcut} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "glass-rim glass-rim-control flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-fast",
          "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40",
          pressed && "text-foreground",
          className,
        )}
      >
        <Icon icon={icon} size="sm" aria-hidden />
      </button>
    </Hint>
  );
}
