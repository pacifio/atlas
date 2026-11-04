import { Check, Loader2, Lock } from "lucide-react";

import { cn } from "@/lib/utils";

import type { PromoteTab } from "../../lib/capture-flow";
import { pillClass } from "./styles";

/**
 * The one affirmative action per view.
 *
 * Atlas has no accent *background* token — `--primary` is white, meant
 * for text and rules — so the primary action inverts, matching the app.
 */
export function PrimaryButton({
  busy,
  disabled,
  onClick,
  label,
}: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-[var(--foreground)] transition-colors hover:bg-element-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy && <Loader2 size={11} className="animate-spin" />}
      {label}
    </button>
  );
}

export function GhostButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium leading-none text-[var(--secondary-foreground)] transition-colors hover:bg-element-hover hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/**
 * One storage choice, as a pill.
 *
 * The explanation lives in a single hint line under the group rather than on
 * each option: two stacked cards each carrying their own sentence made the
 * first thing in the popover the tallest, and the choice is genuinely one line
 * of consequence, not two paragraphs.
 */
export function ModeOption({
  selected,
  disabled,
  reason,
  label,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  /** Why it can't be picked — carried on the control itself, not just below it. */
  reason?: string | null;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? (reason ?? undefined) : undefined}
      onClick={onSelect}
      className={pillClass(disabled ? "disabled" : selected ? "on" : "off")}
    >
      {disabled ? (
        <Lock size={10} />
      ) : (
        selected && <Check size={10} className="text-[var(--foreground)]" />
      )}
      {label}
    </button>
  );
}

export function Tabs({
  tab,
  onTabChange,
  connectDisabled,
  connectReason,
  label = "Set up session capture",
}: {
  tab: PromoteTab;
  onTabChange: (tab: PromoteTab) => void;
  connectDisabled: boolean;
  /** Shown on hover, so the disabled tab explains itself in place. */
  connectReason: string | null;
  label?: string;
}) {
  // Pills rather than a segmented control: these are two *ways in*, not two
  // views of one thing, and the pill row is the same shape the feedback panel
  // uses for its categories.
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
      {(
        [
          ["create", "Create"],
          ["connect", "Connect"],
        ] as const
      ).map(([id, label]) => {
        const disabled = id === "connect" && connectDisabled;
        const on = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={disabled}
            title={disabled ? (connectReason ?? undefined) : undefined}
            className={cn(
              "h-6 rounded-full border px-2.5 text-xs transition-colors",
              disabled
                ? "cursor-not-allowed border-element-hover bg-element-hover text-[var(--muted-foreground)] opacity-40"
                : on
                  ? "cursor-pointer border-element-active bg-element-active text-[var(--foreground)]"
                  : "cursor-pointer border-element-selected bg-element-hover text-[var(--muted-foreground)] hover:bg-element-selected hover:text-[var(--secondary-foreground)]",
            )}
            onClick={() => onTabChange(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
