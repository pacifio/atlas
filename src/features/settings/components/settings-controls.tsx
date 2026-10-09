import { useState } from "react";
import { cn } from "@/lib/utils";

export function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
    </div>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-2xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Toggle — controlled OR uncontrolled. If `checked` is provided the parent
 * owns the state and `onChange` is fired on click; otherwise we keep
 * internal state seeded by `defaultChecked` (original behavior).
 */
export function Toggle({
  defaultChecked = false,
  checked,
  onChange,
  disabled = false,
  label,
  className,
}: {
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  /** For a sub-setting whose parent is off — dimmed and inert, but still
   *  showing its own stored value rather than lying about it. */
  disabled?: boolean;
  /** Accessible name, for a switch whose visible label is not a <label>. */
  label?: string;
  /** Last word on the track's classes — e.g. an off track that must show on
   *  a card-coloured surface, where the default `bg-card` disappears. */
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;
  const apply = (next: boolean) => {
    if (disabled) return;
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };
  // shadcn/Radix switch proportions: the track has a 2px transparent
  // border so its inner content area is exactly the thumb's size,
  // making the thumb fill vertically and animate translate-x-0 → -x-4
  // edge to edge. The thumb flips color when ON because Atlas's accent
  // is pure white — a white-on-white thumb would disappear.
  return (
    <button
      onClick={() => apply(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center",
        "rounded-full border-2 border-transparent transition-colors",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
        value ? "bg-[var(--primary)]" : "bg-[var(--card)]",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-sm",
          "transition-transform duration-150",
          value ? "translate-x-4 bg-[var(--background)]" : "translate-x-0 bg-card-foreground",
        )}
      />
    </button>
  );
}
