// "Send review to agent": the comments a diff tab holds (with no session
// beside it to take them one by one) opened in the ask box as one prompt,
// each comment's lines a chip. The review is let go once the box hands it
// over; cancelling the box keeps it.

import { Send } from "lucide-react";
import { Button } from "@tryatlas/design";

import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";

import { reviewAsk } from "../../lib/review-ask";
import { useReviewDraft, useReviewDraftStore } from "../../stores/review-draft-store";

export function SendReviewButton({ tabId }: { tabId: string }) {
  const comments = useReviewDraft(tabId);
  if (comments.length === 0) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={(e) => {
        const { prompt, context } = reviewAsk(comments);
        const asked = comments.map((c) => c.id);
        openAskAgent({
          context,
          prompt,
          anchor: e.currentTarget,
          // Only what went: a chip taken out of the box, or a comment added
          // while it was open, stays held.
          onAsked: (_result, kept) => {
            const { remove } = useReviewDraftStore.getState().actions;
            for (const i of kept) if (asked[i]) remove(tabId, asked[i]);
          },
        });
      }}
    >
      <Send aria-hidden className="size-3" />
      Send review to agent
      <span className="text-muted-foreground tabular-nums">{comments.length}</span>
    </Button>
  );
}
