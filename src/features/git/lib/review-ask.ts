// A diff tab's held review (`../stores/review-draft-store.ts`) as one ask:
// the comments listed in the prompt, in order, and each one's lines as a
// chip in the same order — a hunk for a comment on the diff, a file range
// for one on a file's own text.

import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
import type { MentionReviewComment } from "@/features/chat/lib/mentions";

export function reviewCommentContext(comment: MentionReviewComment): AgentContext {
  if (comment.fenceLanguage === "diff") {
    return { kind: "diff_hunk", path: comment.filePath, hunk: comment.diff };
  }
  return {
    kind: "file_range",
    path: comment.filePath,
    startLine: Math.min(comment.start, comment.end),
    endLine: Math.max(comment.start, comment.end),
    excerpt: comment.diff,
  };
}

export function reviewAsk(comments: readonly MentionReviewComment[]): {
  prompt: string;
  context: AgentContext[];
} {
  const lines = comments.map(
    // A comment's own line breaks are indented, so the list stays a list.
    (c, i) =>
      `${i + 1}. \`${c.filePath}\` ${c.rangeLabel}: ${c.text.trim().replace(/\n/g, "\n   ")}`,
  );
  const intro =
    comments.length === 1
      ? "I reviewed these changes and left a comment. Address it; its lines are attached."
      : `I reviewed these changes and left ${comments.length} comments. Address each one; their lines are attached in the same order.`;
  return {
    prompt: `${intro}\n\n${lines.join("\n")}`,
    context: comments.map(reviewCommentContext),
  };
}
