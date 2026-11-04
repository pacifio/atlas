// The pull request's ask-agent actions: "Fix with agent" on a failing check,
// "Address with agent" on a review thread, and "Address all feedback" for
// every unresolved thread and failing check at once. Each opens the ask box
// against the button, with the feedback as chips (`pull-request-ask.ts`), so
// the user picks the session and adds what they want to say.
//
// A check's log is read first (from the cache when "View log" already did),
// so its button says "Reading log…" for that moment.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "@tryatlas/design";

import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";
import type { AskAnchor } from "@/features/ask-agent/stores/ask-agent-store";

import {
  ADDRESS_PROMPT,
  addressAllPrompt,
  addressAllSelection,
  checkErrorContext,
  hasFeedback,
  hasMoreFeedback,
  remarkContext,
  threadContext,
  type AskPullRequest,
} from "../lib/pull-request-ask";
import { fetchCheckLogForHandoff } from "../lib/pull-request-check-log";
import type { PrCheck, PrComment, PrReviewThread } from "../lib/pull-requests-types";
import { usePullRequestScope } from "./pull-request-context";

const FIX_PROMPT = "Fix this: ";

/** The button, while it is still on screen; else where it was. */
function anchorAfterWait(button: HTMLElement, rect: DOMRect): AskAnchor {
  return button.isConnected ? button : rect;
}

function useAskPullRequest(): AskPullRequest {
  const { number, headBranch } = usePullRequestScope();
  return { number, headBranch: headBranch ?? null };
}

export function FixCheckWithAgentButton({ check }: { check: PrCheck }) {
  const { repoPath, number } = usePullRequestScope();
  const pr = useAskPullRequest();
  const client = useQueryClient();
  const [reading, setReading] = useState(false);

  const fix = async (button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    setReading(true);
    const log = await fetchCheckLogForHandoff(client, repoPath, number, check);
    setReading(false);
    openAskAgent({
      context: [checkErrorContext(pr, check, log)],
      prompt: FIX_PROMPT,
      anchor: anchorAfterWait(button, rect),
    });
  };

  return (
    <Button size="xs" variant="ghost" disabled={reading} onClick={(e) => void fix(e.currentTarget)}>
      <Sparkles aria-hidden className="size-3" />
      {reading ? "Reading log…" : "Fix with agent"}
    </Button>
  );
}

/** On a review thread, or on a remark that has no thread (a review's
 *  summary). */
export function AddressWithAgentButton({
  feedback,
  className,
}: {
  feedback: { kind: "thread"; thread: PrReviewThread } | { kind: "comment"; comment: PrComment };
  className?: string;
}) {
  const pr = useAskPullRequest();
  const context =
    feedback.kind === "thread"
      ? threadContext(pr, feedback.thread)
      : remarkContext(pr, feedback.comment);
  if (!context) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className={className}
      onClick={(e) =>
        openAskAgent({ context: [context], prompt: ADDRESS_PROMPT, anchor: e.currentTarget })
      }
    >
      <MessageSquarePlus aria-hidden className="size-3" />
      Address with agent
    </Button>
  );
}

/** "Address all feedback": null while there is nothing to address. */
export function useAddressAllFeedback(
  threads: readonly PrReviewThread[],
  checks: readonly PrCheck[],
  threadsTruncated = false,
): { run: (anchor: HTMLElement) => void; reading: boolean } | null {
  const { repoPath, number } = usePullRequestScope();
  const pr = useAskPullRequest();
  const client = useQueryClient();
  const [reading, setReading] = useState(false);
  if (!hasFeedback(threads, checks)) return null;

  const run = (button: HTMLElement) => {
    if (reading) return;
    const rect = button.getBoundingClientRect();
    const pick = addressAllSelection(threads, checks);
    setReading(true);
    void Promise.all(
      pick.checks.map((check) => fetchCheckLogForHandoff(client, repoPath, number, check)),
    )
      .then((logs) => {
        const context: AgentContext[] = [
          ...pick.checks.map((check, i) => checkErrorContext(pr, check, logs[i])),
          ...pick.threads.flatMap((thread) => threadContext(pr, thread) ?? []),
        ];
        openAskAgent({
          context,
          prompt: addressAllPrompt(pr, threadsTruncated || hasMoreFeedback(threads, checks, pick)),
          anchor: anchorAfterWait(button, rect),
        });
      })
      // Never left saying "Reading logs…", whatever went wrong.
      .finally(() => setReading(false));
  };
  return { run, reading };
}

export function AddressAllFeedbackButton({
  threads,
  threadsTruncated,
  checks,
}: {
  threads: readonly PrReviewThread[];
  /** More threads exist than were loaded. */
  threadsTruncated: boolean;
  checks: readonly PrCheck[];
}) {
  const address = useAddressAllFeedback(threads, checks, threadsTruncated);
  if (!address) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={address.reading}
      onClick={(e) => address.run(e.currentTarget)}
    >
      <Sparkles aria-hidden className="size-3" />
      {address.reading ? "Reading logs…" : "Address all feedback"}
    </Button>
  );
}
