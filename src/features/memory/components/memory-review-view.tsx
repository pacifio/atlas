// The Memory panel's Review tab (memory plan M4): what waits for the user.
// Candidates (captured lines nobody confirmed) are approved or dismissed;
// near-duplicates the health pass found are merged into one survivor or told
// apart; contradicting memories are settled by keeping one side or both.
// Nothing here is automatic: every action is the user's, and a dismissed or
// merged memory is archived, never deleted (its history stays).

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  sharedMemory,
  type DreamProposal,
  type MemoryEntry,
  type ReviewQueue,
} from "../lib/shared-memory-api";
import { MEMORY_CHANGED_EVENT } from "../stores/shared-memory-store";
import { CountPill, Notice } from "./views/memory-chrome";
import { Button } from "@tryatlas/design";

const EMPTY: ReviewQueue = { candidates: [], merges: [], conflicts: [], dreams: [] };
const DEBOUNCE_MS = 300;

export function MemoryReviewView({
  projectPath,
  className,
}: {
  projectPath: string;
  className?: string;
}) {
  const [queue, setQueue] = useState<ReviewQueue>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await sharedMemory.review(projectPath);
      if (mine === seq.current) {
        setQueue(next);
        setLoadError(null);
      }
    } catch (err) {
      // A failed read keeps the last queue, and says so while it is empty.
      if (mine === seq.current) setLoadError(errorText(err));
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [projectPath]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    void refresh();
    void listen(MEMORY_CHANGED_EVENT, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh]);

  /** Run one action, then re-read the queue. A failure or a proposal that
   *  went stale is reported; either way the queue is re-read. */
  const act = (run: () => Promise<unknown>) => async () => {
    try {
      if ((await run()) === "obsolete") toast("Memory moved on; nothing was changed");
    } catch (err) {
      toast.error(`Couldn't update memory: ${errorText(err)}`);
    } finally {
      await refresh();
    }
  };

  const dreams = queue.dreams ?? [];
  const empty =
    queue.candidates.length === 0 &&
    queue.merges.length === 0 &&
    queue.conflicts.length === 0 &&
    dreams.length === 0;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-4", className)}>
      {loaded && empty ? (
        <Notice>
          {loadError ? `Couldn't read the review queue: ${loadError}` : "Nothing to review"}
        </Notice>
      ) : null}
      {dreams.length > 0 && (
        <Section title="Proposed by the nightly review" count={dreams.length}>
          {dreams.map((d) => (
            <Card key={d.id}>
              <div className="label">{dreamLabel(d.op)}</div>
              {d.why && <div className="caption">{d.why}</div>}
              {d.entries.map((e) => (
                <Line key={e.id} entry={e} muted />
              ))}
              <Actions>
                <Action
                  label="Accept"
                  onClick={act(() => sharedMemory.acceptDream(projectPath, d.id))}
                />
                <Action
                  label="Dismiss"
                  onClick={act(() => sharedMemory.dismissDream(projectPath, d.id))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.conflicts.length > 0 && (
        <Section title="Contradictions" count={queue.conflicts.length}>
          {queue.conflicts.map(({ a, b }) => (
            <Card key={`${a.id}-${b.id}`}>
              <Line label="A" entry={a} />
              <Line label="B" entry={b} />
              <Actions>
                <Action
                  label="Keep A"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "a"))}
                />
                <Action
                  label="Keep B"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "b"))}
                />
                <Action
                  label="Both hold"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "both"))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.merges.length > 0 && (
        <Section title="Duplicates" count={queue.merges.length}>
          {queue.merges.map(({ keep, drop }) => (
            <Card key={keep.id}>
              <Line label="Keep" entry={keep} />
              {drop.map((d) => (
                <Line key={d.id} label="Same as" entry={d} muted />
              ))}
              <Actions>
                <Action
                  label="Merge"
                  onClick={act(() =>
                    sharedMemory.merge(
                      projectPath,
                      keep.id,
                      drop.map((d) => d.id),
                    ),
                  )}
                />
                <Action
                  label="Not the same"
                  onClick={act(async () => {
                    for (const d of drop) {
                      await sharedMemory.resolveConflict(projectPath, keep.id, d.id, "both");
                    }
                  })}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.candidates.length > 0 && (
        <Section title="Unconfirmed" count={queue.candidates.length}>
          {queue.candidates.map((c) => (
            <Card key={c.id}>
              <Line entry={c} />
              <Actions>
                <Action
                  label="Approve"
                  onClick={act(() => sharedMemory.promote(projectPath, c.id))}
                />
                <Action
                  label="Dismiss"
                  onClick={act(() => sharedMemory.archive(projectPath, [c.id]))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
    </div>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line saying what a proposal would do. */
function dreamLabel(op: DreamProposal["op"]): string {
  switch (op.op) {
    case "add":
      return `Add ${op.kind ?? "memory"}: ${op.content ?? ""}`;
    case "merge":
      return "Merge these into the first";
    case "archive":
      return `Archive (${op.reason ?? "unused"})`;
    case "rewrite":
      return `Rewrite as: ${op.content ?? ""}`;
    case "link":
      return op.rel === "supersedes" ? "The first replaces the second" : "These contradict";
    default:
      return op.op;
  }
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4">
      <h3 className="eyebrow mb-2 flex items-center gap-1.5">
        {title}
        <CountPill count={count} />
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** One proposal: the Usage section card — a hairline in the element ramp's
 *  selected step over the card surface, no shadow. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-element-selected bg-card px-3 py-2.5">
      {children}
    </div>
  );
}

function Line({ label, entry, muted }: { label?: string; entry: MemoryEntry; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      {label && (
        <span className="w-12 shrink-0 text-3xs font-semibold uppercase tracking-wider text-disabled">
          {label}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {entry.content}
      </span>
      <span className="caption shrink-0 tabular-nums">
        {entry.kind} · {entry.agent || entry.source} · {Math.round(entry.confidence * 100)}%
      </span>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 flex items-center gap-1.5">{children}</div>;
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
    </Button>
  );
}
