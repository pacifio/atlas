// The Memories pane when no memory is chosen, props-only: the answer to "what
// do the agents know here" in one glance. How much is remembered and by whom,
// what waits for the user, and the memories agents lean on most.

import { ArrowRight, Inbox } from "lucide-react";
import { timeAgo } from "@/lib/time-ago";
import { Button, Callout } from "@tryatlas/design";
import type { MemoryEntry } from "../../lib/shared-memory-format";
import { AgentName, KindGlyph } from "./memory-entry-parts";

export interface MemoryOverviewViewProps {
  projectName: string;
  current: number;
  unconfirmed: number;
  agents: string[];
  newest: MemoryEntry | null;
  reviewCount: number;
  onOpenReview: () => void;
  mostUsed: MemoryEntry[];
  onSelect: (id: number) => void;
  sharingEnabled: boolean;
}

export function MemoryOverviewView(p: MemoryOverviewViewProps) {
  return (
    <div className="space-y-6 px-4 py-5">
      <div>
        <p className="text-2xs font-medium text-muted-foreground">
          What agents know in {p.projectName}
        </p>
        <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">
          {p.current} {p.current === 1 ? "memory" : "memories"}
        </p>
        {p.agents.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>from</span>
            {p.agents.map((a) => (
              <AgentName key={a} agent={a} />
            ))}
          </p>
        )}
        {p.newest && (
          <p className="mt-1 text-xs text-muted-foreground">
            Last learned {timeAgo(new Date(p.newest.updatedAt).toISOString(), { suffix: true })}
          </p>
        )}
      </div>

      {!p.sharingEnabled && (
        <Callout tone="warning">
          Sharing is off for this project, so agents neither read nor add to this memory.
        </Callout>
      )}

      {p.reviewCount > 0 && (
        <Callout
          tone="neutral"
          icon={Inbox}
          action={
            <Button size="xs" variant="outline" onClick={p.onOpenReview}>
              Review
              <ArrowRight aria-hidden className="size-3" />
            </Button>
          }
        >
          <p className="font-medium text-foreground">{p.reviewCount} waiting for you</p>
          <p className="mt-0.5">
            Unconfirmed lines, duplicates and contradictions stay out of the way until you decide.
          </p>
        </Callout>
      )}

      {p.mostUsed.length > 0 && (
        <section aria-label="Leaned on most">
          <h4 className="mb-1.5 text-2xs font-medium text-muted-foreground">Leaned on most</h4>
          <ul className="space-y-0.5">
            {p.mostUsed.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => p.onSelect(e.id)}
                  className="flex w-full cursor-pointer items-start gap-2 rounded px-1.5 py-1.5 text-left transition-colors duration-fast ease-out-strong hover:bg-element-hover"
                >
                  <KindGlyph kind={e.kind} className="mt-0.5 text-muted-foreground" />
                  <span className="line-clamp-2 min-w-0 flex-1 text-xs text-foreground">
                    {e.content}
                  </span>
                  <span className="shrink-0 pt-px text-2xs text-muted-foreground tabular-nums">
                    {e.uses}×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-2xs leading-relaxed text-disabled">
        Agents read this through Atlas's memory tools when they need it; nothing is pasted into
        their prompts. Choose a memory to see the session it came from, or to fix or forget it.
      </p>
    </div>
  );
}
