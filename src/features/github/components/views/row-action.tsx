import type { LucideIcon } from "lucide-react";
import { Icon, Spinner, iconButtonVariants } from "@tryatlas/design";
import { cn } from "@/lib/utils";

/**
 * A row's icon action: `IconButton`'s square on a plain button, because a
 * busy action swaps its glyph for a `Spinner`, which the primitive's fixed
 * `icon` can't. `label` is the accessible name and matches the `HintItem`
 * around it.
 */
export function RowAction({
  icon,
  label,
  busy = false,
  disabled = false,
  variant = "ghost",
  className,
  onClick,
  onBlur,
}: {
  icon: LucideIcon;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  variant?: "ghost" | "ghost-destructive";
  className?: string;
  onClick: () => void;
  onBlur?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      // The recipe styles disabled through Base UI's attribute.
      data-disabled={disabled ? "" : undefined}
      onClick={onClick}
      onBlur={onBlur}
      className={cn(iconButtonVariants({ size: "xs", variant }), className)}
    >
      {busy ? <Spinner size="xs" label="" /> : <Icon icon={icon} size="xs" />}
    </button>
  );
}
