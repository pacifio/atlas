// "Memory updated": what this chat session saved to shared memory, under its
// transcript, with a one-click Forget (memory plan M4). It makes an agent's
// writes visible where they happen, which is also the cheapest check against
// a bad memory: the user sees "always force-push" right after the turn that
// wrote it. Nothing renders until the session writes something.

import { useState } from "react";
import { Brain, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { KIND_ICON, kindLabel } from "../lib/memory-kind-icon";
import { openMemoryEntry } from "../lib/open-memory-entry";
import { sharedMemory } from "../lib/shared-memory-api";
import {
  useSessionMemoryWrites,
  writesSummary,
  type SessionWrite,
} from "../lib/use-session-memory-writes";

/** Matches the transcript's tool markers (`ICON_PX` / `ICON_STROKE`), because
 *  this block sits in the same column as them and reads as one of them. */
const ICON_PX = 14;
const ICON_STROKE = 1.5;

export function MemoryUpdatedCard({
  projectPath,
  sessionId,
  since = 0,
  className,
}: {
  projectPath: string | null;
  sessionId: string | null;
  since?: number;
  className?: string;
}) {
  const { writes, refresh } = useSessionMemoryWrites(projectPath, sessionId, since);
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState<SessionWrite | null>(null);
  if (!projectPath || writes.length === 0) return null;

  const forget = async (w: SessionWrite) => {
    try {
      await sharedMemory.forgetEntry(projectPath, w.id);
    } catch (err) {
      toast.error(`Couldn't forget: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refresh();
    }
  };

  return (
    // The same centred column every transcript row uses
    // (`transcript-rows.tsx`'s `Column`): `max-w-(--atlas-chat-column)` AND `px-6`. Without
    // the padding this block was 760px against every neighbour's 712px, so it
    // hung 24px past the turn above it on both sides.
    <div className={cn("mx-auto w-full max-w-(--atlas-chat-column) px-6 py-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="atlas-marker group/memory w-full cursor-pointer text-left text-base text-muted-foreground hover:text-secondary-foreground"
      >
        <span className="flex w-4 shrink-0 justify-center">
          <Brain size={ICON_PX} strokeWidth={ICON_STROKE} />
        </span>
        <span className="min-w-0 truncate">Memory updated: {writesSummary(writes)}</span>
        <ChevronRight
          size={ICON_PX}
          strokeWidth={ICON_STROKE}
          className={cn(
            "shrink-0",
            // Same reveal as a tool fold: the chevron is a hint, not chrome, so
            // it stays out of the line until the row is reached for.
            open
              ? "rotate-90 opacity-100"
              : "opacity-0 group-hover/memory:opacity-100 group-focus-visible/memory:opacity-100",
          )}
        />
      </button>

      {open && (
        <ul className="mt-0.5 flex flex-col">
          {writes.map((w) => {
            const Icon = KIND_ICON[w.kind] ?? Brain;
            return (
              <li
                key={w.rev}
                // A rule under each row and none around them: the group reads
                // as a list rather than as a stack of boxes, which is what the
                // bordered card it replaced looked like. `last:border-b-0`
                // keeps the group from drawing a line into the space below it.
                className="flex items-start gap-2.5 border-b border-border py-1.5 last:border-b-0"
              >
                <span
                  title={kindLabel(w.kind)}
                  className="flex w-4 shrink-0 justify-center pt-px text-muted-foreground"
                >
                  <Icon size={ICON_PX} strokeWidth={ICON_STROKE} aria-hidden />
                  <span className="sr-only">{kindLabel(w.kind)}</span>
                </span>

                {w.live ? (
                  <button
                    type="button"
                    onClick={() => openMemoryEntry(w.id)}
                    className="min-w-0 flex-1 break-words text-left text-xs text-foreground hover:underline"
                  >
                    {w.content}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 break-words text-xs text-foreground">
                    {w.content || "(forgotten)"}
                  </span>
                )}

                {w.live && w.state === "candidate" && (
                  <span className="shrink-0 pt-0.5 text-3xs uppercase text-muted-foreground">
                    candidate
                  </span>
                )}
                {/* Forgotten or archived since, by anyone: nothing left to forget. */}
                {!w.live && w.op !== "forget" && (
                  <span className="shrink-0 pt-0.5 text-3xs uppercase text-muted-foreground">
                    removed
                  </span>
                )}

                {w.live && (
                  <button
                    type="button"
                    aria-label="Forget"
                    title="Forget this memory"
                    onClick={() => setForgetting(w)}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground transition-colors duration-fast hover:border-destructive hover:text-destructive"
                  >
                    <X size={10} strokeWidth={ICON_STROKE} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <FileTreeConfirmDelete
        open={forgetting !== null}
        name={forgetting?.content ?? ""}
        isDir={false}
        title="Forget this memory?"
        body="Every agent on this project stops seeing it, and it no longer shows in search. This can't be undone."
        confirmLabel="Forget"
        onConfirm={() => {
          if (forgetting) void forget(forgetting);
          setForgetting(null);
        }}
        onOpenChange={(v) => {
          if (!v) setForgetting(null);
        }}
      />
    </div>
  );
}
