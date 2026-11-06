import { cn } from "@/lib/utils";

import { GhostButton, PrimaryButton } from "./controls";
import { GROUP } from "./styles";

/**
 * The bulk-disclosure step: real numbers, then a genuine choice.
 *
 * Cancel invokes nothing — every mutation belongs to Confirm.
 */
export function DisclosureStep({
  title,
  lines,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  lines: string[];
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="atlas-fade-in space-y-2.5">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <ul className={cn(GROUP, "space-y-1")}>
        {lines.map((line) => (
          <li key={line} className="text-xs text-secondary-foreground">
            {line}
          </li>
        ))}
      </ul>
      <p className="text-2xs text-muted-foreground">
        This makes the above visible to your Organization. Nothing is sent until you confirm.
      </p>
      <div className="flex justify-end gap-2 pt-0.5">
        <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
        <PrimaryButton busy={busy} onClick={onConfirm} label={confirmLabel} />
      </div>
    </div>
  );
}
