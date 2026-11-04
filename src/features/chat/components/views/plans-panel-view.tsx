import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Icon } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { type PlanRecord, formatPlanTimestamp, planTimeAgo } from "../../lib/plans";

/**
 * The project's captured plans, newest first: the message that triggered each
 * one, when, in which session, and the plan itself behind a disclosure.
 * Which plans are open is this view's own state.
 */
export function PlansPanelView({
  plans,
  fileRoot,
  defaultExpandedIds,
}: {
  plans: PlanRecord[];
  /** Resolves file links inside a plan's markdown. */
  fileRoot: string | null;
  defaultExpandedIds?: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpandedIds));
  const setOpen = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="flex-1 overflow-y-auto hide-scrollbar">
      {plans.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground leading-relaxed">
          No plans yet. When Claude Code proposes a plan, it’s saved here with the message that
          triggered it.
        </div>
      ) : (
        plans.map((p, idx) => {
          const isOpen = expanded.has(p.id);
          return (
            <div
              key={p.id}
              className={cn(
                "px-3 py-2.5",
                idx < plans.length - 1 && "border-b border-border-subtle",
              )}
            >
              <Collapsible open={isOpen} onOpenChange={(open) => setOpen(p.id, open)}>
                <CollapsibleTrigger
                  className="group flex w-full cursor-pointer items-start text-left"
                  title={isOpen ? "Collapse plan" : "Expand plan"}
                >
                  <span className="mr-1.5 flex shrink-0">
                    <Icon
                      icon={isOpen ? ChevronDown : ChevronRight}
                      size="sm"
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                  </span>
                  <span
                    className={cn(
                      "text-sm leading-snug text-secondary-foreground group-hover:text-foreground transition-colors",
                      !isOpen && "line-clamp-2",
                    )}
                  >
                    {p.userMessage || "(no message)"}
                  </span>
                </CollapsibleTrigger>

                <div className="flex items-center gap-2 pl-[18px] mt-1 text-2xs text-muted-foreground">
                  <span title={p.timestamp}>{formatPlanTimestamp(p.timestamp)}</span>
                  <span>·</span>
                  <span>{planTimeAgo(p.timestamp)}</span>
                  {p.sessionTitle && (
                    <>
                      <span>·</span>
                      <span className="truncate">{p.sessionTitle}</span>
                    </>
                  )}
                </div>

                <CollapsibleContent>
                  <div className="pl-[18px] mt-2 rounded-md border border-border-subtle bg-background px-3 py-2 max-h-[420px] overflow-auto">
                    <Markdown className="text-sm" fileRoot={fileRoot}>
                      {p.plan}
                    </Markdown>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          );
        })
      )}
    </div>
  );
}
