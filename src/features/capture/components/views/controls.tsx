import type { KeyboardEvent } from "react";
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
 * The group is one Tab stop (the chosen option); the arrow keys move to the
 * next enabled option and choose it, as a radio group does. The parent
 * `role="radiogroup"` wires the keys with `rovingKeys(e, "radio", true)`.
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
      tabIndex={selected ? 0 : -1}
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
  // tab. One Tab stop, the selected tab (Create when the selected one cannot
  // be used); the arrow keys move between the enabled tabs and Enter or Space
  // opens one, so arrowing past a tab never swaps the form under the reader.
  const selectedDisabled = tab === "connect" && connectDisabled;
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1"
      onKeyDown={(e) => rovingKeys(e, "tab", false)}
    >
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
            tabIndex={(on && !selectedDisabled) || (selectedDisabled && id === "create") ? 0 : -1}
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

const NEXT = new Set(["ArrowRight", "ArrowDown"]);
const PREV = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * Arrow-key movement inside a one-Tab-stop group of `role` buttons: ←/↑ and
 * →/↓ move to the previous or next enabled one and wrap, Home and End jump to
 * either end. Disabled options are skipped. `activate` clicks the option focus
 * lands on — a radio group's rule, where moving IS choosing.
 */
export function rovingKeys(
  e: KeyboardEvent<HTMLElement>,
  role: "tab" | "radio",
  activate: boolean,
): void {
  if (!NEXT.has(e.key) && !PREV.has(e.key) && e.key !== "Home" && e.key !== "End") return;
  const options = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      `[role="${role}"]:not(:disabled):not([aria-disabled="true"])`,
    ),
  );
  const at = options.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const n = options.length;
  const to =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? n - 1
        : NEXT.has(e.key)
          ? (at + 1) % n
          : (at - 1 + n) % n;
  options[to].focus();
  if (activate && to !== at) options[to].click();
}
