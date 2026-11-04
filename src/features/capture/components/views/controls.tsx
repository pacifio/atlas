import { Check, Lock } from "lucide-react";

import { Button, Spinner } from "@tryatlas/design";

import type { PromoteTab } from "../../lib/capture-flow";

/**
 * The one affirmative action per view.
 *
 * The package's `default` button is the inverted primary — `--primary` is the
 * foreground ink, so the fill is light on a dark theme and dark on a light
 * one — which is what marks it as the one action that moves the flow on.
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
    <Button variant="default" size="sm" disabled={busy || disabled} onClick={onClick}>
      {busy && <Spinner size="xs" label="" />}
      {label}
    </Button>
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
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * One storage choice.
 *
 * The explanation lives in a single hint line under the group rather than on
 * each option: two stacked cards each carrying their own sentence made the
 * first thing in the popover the tallest, and the choice is genuinely one line
 * of consequence, not two paragraphs.
 *
 * Each option is its own Tab stop, activated with Enter or Space. Arrow keys
 * between the two (a roving radio group) are a proposed behaviour change
 * awaiting review (ATL-718), so this stays a pair of `role="radio"` buttons.
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
    <Button
      variant={selected ? "outline" : "ghost"}
      size="sm"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      title={disabled ? (reason ?? undefined) : undefined}
      onClick={onSelect}
    >
      {disabled ? <Lock size={10} /> : selected && <Check size={10} />}
      {label}
    </Button>
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
  // Two *ways in*, not two views of one thing, so the selected one is drawn
  // the way a chosen option is (an outlined button) rather than as a page
  // tab. Each is its own Tab stop: arrow keys between them are a proposed
  // behaviour change awaiting review (ATL-718).
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
          <Button
            key={id}
            variant={on ? "outline" : "ghost"}
            size="sm"
            role="tab"
            aria-selected={on}
            disabled={disabled}
            title={disabled ? (connectReason ?? undefined) : undefined}
            onClick={() => onTabChange(id)}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
