// A session-scoped elicitation, rendered where the user is already looking.
//
// Two very different things arrive on this one wire, and they want two
// different surfaces:
//
//   - An agent's AskUserQuestion. The Claude adapter bridges it to a form
//     elicitation whose fields are titled `oneOf`/`anyOf` enums plus a
//     free-text companion per question. That is multiple choice, and it belongs
//     in the question card pinned above the composer — the same place the
//     permission card sits, and where Claude Code itself puts it. A modal is
//     wrong for it twice over: it covers the conversation the question is
//     about, and it makes answering feel like an interruption rather than part
//     of the thread.
//
//   - A genuine form from an MCP server (a branch name, a number, a yes/no).
//     The question card cannot represent those, so they keep the dialog.
//
// `elicitationQuestionForm` is what decides, by looking at the schema rather
// than at which agent sent it — so any ACP agent that bridges questions this
// way gets the card for free.

import { useMemo } from "react";
import { toast } from "sonner";
import { agents } from "../lib/agents-api";
import {
  elicitationAnswerContent,
  elicitationQuestionForm,
  parseElicitationSchema,
} from "../lib/elicitation-schema";
import { ApprovalCard } from "./approval-card";
import { ElicitationModal, type PendingElicitation } from "./elicitation-modal";

export function SessionElicitation({
  pending,
  onClose,
}: {
  pending: PendingElicitation;
  onClose: () => void;
}) {
  const form = useMemo(() => {
    if (pending.mode !== "form") return null;
    return elicitationQuestionForm(
      parseElicitationSchema(pending.requestedSchema),
      pending.message,
    );
  }, [pending.mode, pending.requestedSchema, pending.message]);

  if (!form) return <ElicitationModal pending={pending} onClose={onClose} />;

  // Only dismiss on SUCCESS. The agent is blocked awaiting this reply, so a
  // send that failed and still closed the card left it waiting forever with
  // nothing on screen to retry from — which is exactly how a wire-shape bug
  // here stayed invisible.
  const respond = (action: "accept" | "decline", content?: Record<string, unknown>) => {
    agents
      .respondElicitation(pending.agentId, pending.requestId, action, content)
      .then(onClose)
      .catch((e) => toast.error(`Could not send your answer: ${e}`));
  };

  return (
    <div className="px-4 pt-2">
      <ApprovalCard
        key={pending.requestId}
        questions={form.questions}
        onSubmit={(answers) => respond("accept", elicitationAnswerContent(form, answers))}
        // `decline`, not `cancel`: declining answers "nothing, carry on" and the
        // agent continues its turn, where cancel aborts the tool call outright.
        onSkip={() => respond("decline")}
      />
    </div>
  );
}
