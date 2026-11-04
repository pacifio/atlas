import { cn } from "@/lib/utils";
import type { Organisation } from "../../types";
import { orgInitials } from "../../lib/org-switcher-model";

/**
 * An organisation's mark: its logo, else its initials on a flat square.
 *
 * Flat rather than raised: repeated down a menu, a dozen raised chips fight the
 * row highlight for depth. An org colour, when set, is the square's fill; the
 * initials keep the foreground.
 */
export function OrgMark({ org, size = 16 }: { org: Organisation; size?: number }) {
  if (org.logo) {
    return (
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-md"
        style={{ width: size, height: size }}
      >
        <img src={org.logo} alt="" className="size-full object-cover" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-semibold text-foreground",
        "text-3xs leading-none",
        !org.color && "bg-element-hover",
      )}
      style={{ width: size, height: size, background: org.color }}
    >
      {orgInitials(org.name)}
    </span>
  );
}
