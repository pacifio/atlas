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
import { ComposerDrawer } from "./composer-drawer";
import { ElicitationModal, type PendingElicitation } from "./elicitation-modal";

export function SessionElicitation({
  pending,
  onClose,
  remoteDriver = null,
}: {
  /** `null` once answered. Mounted either way: the drawer needs to outlive the
   *  card to animate it out, so the parent keeps this component and changes
   *  this prop rather than unmounting. */
  pending: PendingElicitation | null;
  onClose: () => void;
  /** Who drives from remote control when it is not this account (`null`
   *  otherwise). Answering a question is steering: only the driver may, so
   *  the card is replaced by a line saying so until the seat comes back. */
  remoteDriver?: string | null;
}) {
  const form = useMemo(() => {
    if (!pending || pending.mode !== "form") return null;
    return elicitationQuestionForm(
      parseElicitationSchema(pending.requestedSchema),
      pending.message,
    );
  }, [pending]);

  // A genuine form keeps the dialog — the question card cannot represent a
  // branch name or a number. The empty drawer still renders so a card that was
  // open a moment ago finishes animating out.
  if (pending && !form) {
    return (
      <>
        <ComposerDrawer>{null}</ComposerDrawer>
        <ElicitationModal pending={pending} onClose={onClose} remoteDriver={remoteDriver} />
      </>
    );
  }
  if (!pending || !form) return <ComposerDrawer>{null}</ComposerDrawer>;
  if (remoteDriver) {
    return (
      <ComposerDrawer>
        <p
          data-testid="elicitation-seat-notice"
          className="px-4 py-3 text-xs text-[var(--secondary-foreground)]"
        >
          The agent has a question. {remoteDriver} is driving from remote control, so only they can
          answer it — take over at the composer to answer it yourself.
        </p>
      </ComposerDrawer>
    );
  }

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
    <ComposerDrawer>
      <ApprovalCard
        key={pending.requestId}
        questions={form.questions}
        onSubmit={(answers) => respond("accept", elicitationAnswerContent(form, answers))}
        // `decline`, not `cancel`: declining answers "nothing, carry on" and the
        // agent continues its turn, where cancel aborts the tool call outright.
        onSkip={() => respond("decline")}
        skipLabel="Decline"
      />
    </ComposerDrawer>
  );
}
