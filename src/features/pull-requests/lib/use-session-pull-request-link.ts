// The ⋯ menu's first item: whether the pull request is linked to the session
// beside its tab, and the toggle. "This session" is the chat tab beside the
// pull request when it is in the same project (`currentSessionTab`); with no
// such session, or one not recorded in the history yet, the item is hidden.
//
// The links ride on the session's history row (`ThreadRow.pullRequests`),
// which re-reads on `atlas:threads-changed` — the link and unlink commands
// fire it, so the item follows without being told.

import { useState } from "react";
import { toast } from "sonner";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useThreadHistory } from "@/features/session-context/lib/session-lineage";

import { useCurrentSessionTab } from "./pr-agent-session";
import { classifyPrError, prErrorMessage } from "./pr-errors";
import { linkKey } from "./session-pull-request-links";
import { linkSessionPullRequest, unlinkSessionPullRequest } from "./session-pull-requests-api";

export interface SessionPullRequestLink {
  /** Linked to this session already: the item unlinks. */
  linked: boolean;
  pending: boolean;
  toggle: () => void;
}

export function useSessionPullRequestLink(
  repoPath: string,
  pr: { repository: string; number: number } | null,
): SessionPullRequestLink | null {
  const tabId = useCurrentSessionTab(repoPath);
  const sessionId = useChatStore((s) => (tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null));
  const rows = useThreadHistory(!!sessionId);
  const row = sessionId ? rows.find((r) => r.sessionId === sessionId) : undefined;
  const [pending, setPending] = useState(false);
  if (!pr || !row) return null;

  const key = linkKey(pr);
  const linked = row.pullRequests.some((link) => linkKey(link) === key);
  const toggle = () => {
    if (pending) return;
    setPending(true);
    const change = linked
      ? unlinkSessionPullRequest(row.threadId, pr.repository, pr.number)
      : linkSessionPullRequest(row.threadId, repoPath, pr.number);
    void change
      .then(() => toast.success(linked ? "Unlinked from this session" : "Linked to this session"))
      .catch((raw: unknown) =>
        toast.error(
          linked ? "Could not unlink the pull request" : "Could not link the pull request",
          { description: prErrorMessage(classifyPrError(raw)) },
        ),
      )
      .finally(() => setPending(false));
  };
  return { linked, pending, toggle };
}
