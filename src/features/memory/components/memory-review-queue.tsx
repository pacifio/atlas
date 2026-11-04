// Container for the Review tab: the store's review queue, ordered
// (`lib/memory-review-items.ts`) with the user's "Later"s at the back, and
// each choice sent to the backend. Every choice re-reads the record whether
// it worked or not; a failure or a proposal that went stale is said in a
// toast. The markup is `./views/memory-review-queue-view.tsx`.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { sharedMemory } from "../lib/shared-memory-api";
import { orderQueue, reviewItems, type ReviewItem } from "../lib/memory-review-items";
import { MemoryReviewQueueView, type ReviewChoice } from "./views/memory-review-queue-view";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The backend call a choice makes. */
function callFor(item: ReviewItem, choice: ReviewChoice): (pp: string) => Promise<unknown> {
  switch (item.type) {
    case "candidate":
      return choice === "approve"
        ? (pp) => sharedMemory.promote(pp, item.entry.id)
        : (pp) => sharedMemory.archive(pp, [item.entry.id]);
    case "conflict": {
      const keep = choice === "keep-a" ? "a" : choice === "keep-b" ? "b" : "both";
      return (pp) => sharedMemory.resolveConflict(pp, item.a.id, item.b.id, keep);
    }
    case "merge":
      return choice === "merge"
        ? (pp) =>
            sharedMemory.merge(
              pp,
              item.keep.id,
              item.drop.map((d) => d.id),
            )
        : async (pp) => {
            for (const d of item.drop) {
              await sharedMemory.resolveConflict(pp, item.keep.id, d.id, "both");
            }
          };
    case "dream":
      return choice === "accept"
        ? (pp) => sharedMemory.acceptDream(pp, item.proposal.id)
        : (pp) => sharedMemory.dismissDream(pp, item.proposal.id);
  }
}

export function MemoryReviewQueue() {
  const review = useSharedMemoryStore.use.review();
  const reviewError = useSharedMemoryStore.use.reviewError();
  const loaded = useSharedMemoryStore.use.loaded();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const { reviewAction, refresh, load } = useSharedMemoryStore.use.actions();
  const [skipped, setSkipped] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const items = useMemo(() => orderQueue(reviewItems(review), skipped), [review, skipped]);

  const choose = async (item: ReviewItem, choice: ReviewChoice) => {
    setPending(true);
    try {
      if ((await reviewAction(callFor(item, choice))) === "obsolete") {
        toast("Memory moved on; nothing was changed");
      }
    } catch (err) {
      toast.error(`Couldn't update memory: ${errorText(err)}`);
    } finally {
      setPending(false);
      setSkipped((s) => s.filter((k) => k !== item.key));
    }
  };

  return (
    <MemoryReviewQueueView
      loaded={loaded}
      error={reviewError}
      onRetry={() => {
        if (loaded) void refresh();
        else if (projectPath) void load(projectPath);
      }}
      items={items}
      pending={pending}
      onChoose={(item, choice) => void choose(item, choice)}
      onLater={(item) => setSkipped((s) => [...s.filter((k) => k !== item.key), item.key])}
      onBringForward={(item) => {
        // Everything ahead of it goes to the back, in order: it comes to the
        // front without reshuffling the rest.
        const at = items.findIndex((i) => i.key === item.key);
        const ahead = items.slice(0, at).map((i) => i.key);
        setSkipped((s) => [...s.filter((k) => !ahead.includes(k) && k !== item.key), ...ahead]);
      }}
    />
  );
}
