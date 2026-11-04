import type { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

/** One finding: verdict icon, the value, and what the value is. */
export function StatusRow({
  icon: Icon,
  ok,
  value,
  caption,
  mono = true,
}: {
  icon: typeof GitBranch;
  ok: boolean;
  value: string;
  caption: string;
  /** Paths, URLs and SHAs read better monospaced; counts and names do not. */
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon
        size={11}
        strokeWidth={1.75}
        className={cn("shrink-0", ok ? "text-[var(--secondary-foreground)]" : "text-disabled")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          mono && "font-mono",
          ok ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
        )}
      >
        {value}
      </span>
      <span className="shrink-0 text-3xs uppercase tracking-[0.08em] text-disabled">{caption}</span>
    </div>
  );
}
