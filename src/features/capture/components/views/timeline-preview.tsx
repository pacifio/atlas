import { Layers } from "lucide-react";

import { cn } from "@/lib/utils";

import { GROUP } from "./styles";

/**
 * A small mock of what capture is *for*.
 *
 * The form above answers "where do sessions go"; nothing on the screen answered
 * "and then what". This is the answer, at a glance: a prompt, the work, and the
 * commit it turned into, on one thread. It is an illustration rather than live
 * data on purpose — there is nothing recorded yet, and a real-looking empty
 * state would undersell the feature at the exact moment it is being sold.
 *
 * The pulse running the rail is what stops it reading as a screenshot.
 */
export function TimelinePreview() {
  const rows = [
    { dot: "prompt", text: "Fix the parser panic", meta: "prompt" },
    { dot: "tool", text: "Edit src/parser.rs", meta: "3 files" },
    { dot: "commit", text: "a1b2c3d parser: guard empty input", meta: "checkpoint" },
  ] as const;

  return (
    <div className={cn(GROUP, "overflow-hidden")}>
      <div className="flex items-center gap-1.5">
        <Layers size={10} className="text-[var(--muted-foreground)]" />
        <span className="text-3xs font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
          Timeline
        </span>
        <span className="ml-auto text-3xs text-[var(--atlas-text-disabled)]">preview</span>
      </div>

      <div className="relative mt-2">
        {/* The rail sits behind the nodes, centred on them: the dots are 7px, so
            a 1px line at 3px is their axis. Insetting it top and bottom stops it
            poking out past the first and last node. The nodes themselves are
            laid out in flow — hand-positioning them meant re-deriving a magic
            offset every time the row height changed. */}
        <span className="absolute bottom-[7px] left-[3px] top-[7px] w-px bg-[var(--atlas-element-active)]" />
        <span
          className="atlas-timeline-beam absolute left-[2px] top-[3px] h-2.5 w-[3px] rounded-full bg-[var(--atlas-status-success-foreground)]"
          style={{ "--atlas-beam-travel": "42px" } as React.CSSProperties}
        />

        <div className="space-y-1.5">
          {rows.map((row, i) => (
            <div
              key={row.text}
              className="atlas-timeline-row flex items-center gap-2"
              style={{ animationDelay: `${120 + i * 90}ms` }}
            >
              <span
                className={cn(
                  "relative size-[7px] shrink-0 rounded-full border",
                  row.dot === "commit"
                    ? "border-[var(--atlas-status-success-foreground)] bg-[var(--atlas-status-success-foreground)]"
                    : "border-border-strong bg-[var(--card)]",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs",
                  row.dot === "commit"
                    ? "font-mono text-[var(--secondary-foreground)]"
                    : "text-[var(--secondary-foreground)]",
                )}
              >
                {row.text}
              </span>
              <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">
                {row.meta}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-2xs text-[var(--muted-foreground)]">
        Every prompt, tool call and commit, kept on one thread you can reopen months later.
      </p>
    </div>
  );
}
