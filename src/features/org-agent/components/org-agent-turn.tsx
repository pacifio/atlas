// One exchange with the agent: what the member asked (their bubble, with the
// things they mentioned as chips), then what Atlas did in the order it did it
// — its plan, the tools it ran and the records they returned, its words, the
// approvals it asked for, the questions it put — and how the turn ended. The
// actions arrive once it has ended: copy, rate, ask again.
//
// The web's `conversation.tsx`, `approval-card.tsx` and `research.tsx`, drawn
// in the desktop's coding-chat idiom: the question is the chat's bubble, the
// answer is prose on the page, tool calls are quiet lines.
//
// This file is the container: it reads the store and hands the views under
// `views/` what they draw and how to send.

import { CircleDashed } from "lucide-react";

import type { OrgAgentTarget } from "../lib/org-agent-links";
import {
  turnEnded,
  turnText,
  type ApprovalBlock,
  type QuestionBlock,
  type Turn,
} from "../lib/org-agent-log";
import type { AskStatus } from "../lib/org-agent-types";
import { useOrgAgentStore, type PendingSend } from "../stores/org-agent-store";
import { OrgAgentMarkdown } from "./org-agent-markdown";
import {
  ApprovalFormView,
  ApprovalSummary,
  QuestionCardView,
} from "./views/org-agent-decision-views";
import { ReportView, ResearchProgress } from "./views/org-agent-research-views";
import {
  groupBlocks,
  LimitNotice,
  Notice,
  PlanList,
  PromptBubble,
  ToolSteps,
  TurnActions,
  Uncited,
  WorkingLabel,
  WorkingLine,
} from "./views/org-agent-turn-parts";
import { Button } from "@tryatlas/design";

export { EFFORT_LABEL, Notice, PromptBubble } from "./views/org-agent-turn-parts";

/** A message on its way: drawn at once, dimmed, until its echo takes its
 *  place. A refused one says why and offers Retry. */
export function PendingTurn({ pending }: { pending: PendingSend }) {
  const { retrySend, discardSend } = useOrgAgentStore.use.actions();
  return (
    <div className="flex flex-col gap-2">
      <PromptBubble
        text={pending.text}
        mentions={pending.mentions}
        effort={pending.effort}
        deepResearch={pending.mode === "deep_research"}
        pending={!pending.failed}
      />
      {pending.failed ? (
        <Notice tone="error">
          <span className="min-w-0 flex-1">Not sent. {pending.failed}</span>
          <Button size="xs" variant="outline" onClick={() => retrySend(pending.clientMsgId)}>
            Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={() => discardSend(pending.clientMsgId)}>
            Discard
          </Button>
        </Notice>
      ) : (
        <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <CircleDashed size={11} />
          Sending
        </p>
      )}
    </div>
  );
}

// ── A whole turn ────────────────────────────────────────────────────────────

export function TurnView({
  askId,
  turn,
  status,
  live,
  last,
  handles,
  vote,
  onOpen,
}: {
  askId: string;
  turn: Turn;
  /** The Ask's status: only its last turn can still be working. */
  status: AskStatus;
  /** This is the Ask's last turn. */
  live: boolean;
  /** The newest answer: the only one that can be asked again. */
  last: boolean;
  handles: ReadonlyMap<string, OrgAgentTarget>;
  vote: "up" | "down" | null;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const { send, regenerate, vote: rate, cancelResearch } = useOrgAgentStore.use.actions();
  const ended = turnEnded(turn);
  const working = live && !ended && status !== "idle";
  const groups = groupBlocks(turn.blocks);
  const research = turn.user?.mode === "deep_research" || turn.research !== null;

  return (
    <div className="flex flex-col gap-3">
      {turn.user && (
        <PromptBubble
          text={turn.user.text}
          mentions={turn.user.mentions}
          effort={turn.user.effort}
          deepResearch={turn.user.mode === "deep_research"}
          onOpen={onOpen}
        />
      )}
      {!turn.user && turn.key === 0 && (
        <p className="text-2xs text-muted-foreground">A Loop ran this.</p>
      )}

      <div className="flex min-w-0 flex-col gap-3">
        {turn.plan && <PlanList steps={turn.plan} />}

        {groups.map((g, i) =>
          g.kind === "tools" ? (
            <ToolSteps key={i} tools={g.tools} live={working} onOpen={onOpen} />
          ) : g.block.kind === "text" ? (
            <OrgAgentMarkdown key={i} source={g.block.text} handles={handles} onOpen={onOpen} />
          ) : g.block.kind === "approval" ? (
            <ApprovalView key={i} block={g.block} onOpen={onOpen} />
          ) : g.block.kind === "question" ? (
            <QuestionView key={i} block={g.block} />
          ) : null,
        )}

        {research &&
          !turn.report &&
          (turn.research ? (
            <ResearchProgress
              research={turn.research}
              cancelable={working}
              onCancel={() => cancelResearch(askId, turn.research!.job_id)}
            />
          ) : working ? (
            <WorkingLabel label="Starting Deep research" />
          ) : null)}
        {turn.report && <ReportView report={turn.report} handles={handles} onOpen={onOpen} />}

        {working && !research && <WorkingLine turn={turn} status={status} />}
        {!ended && !working && turn.user && (
          <p className="text-2xs text-muted-foreground">Stopped.</p>
        )}

        {turn.memory.length > 0 && (
          <p className="text-2xs text-muted-foreground">
            {turn.memory.some((m) => !m.forgotten)
              ? "Atlas remembered this for next time."
              : "Atlas forgot what you asked it to."}
          </p>
        )}
        {turn.limit && (
          <LimitNotice
            which={turn.limit.which}
            canContinue={turn.limit.can_continue && last}
            onContinue={() => send(askId, "Continue")}
          />
        )}
        {turn.error && (
          <Notice tone="error">
            {turn.error.message || "Atlas ran into a problem with this answer."}
          </Notice>
        )}
        {turn.done && turn.done.uncited.length > 0 && <Uncited count={turn.done.uncited.length} />}

        {ended && (turn.done || turn.report) && (
          <TurnActions
            copy={turn.report ? turn.report.text : turnText(turn)}
            vote={vote}
            onVote={turn.doneSeq !== null ? (r) => rate(askId, turn.doneSeq!, r) : undefined}
            onRegenerate={last ? () => regenerate(askId) : undefined}
            worked={turn.endedAt !== null ? turn.endedAt - turn.at : null}
          />
        )}
      </div>
    </div>
  );
}

// ── Questions ───────────────────────────────────────────────────────────────

/** A question Atlas asked: its choices as buttons, and a line of free text
 *  when it allows one. */
function QuestionView({ block }: { block: QuestionBlock }) {
  const { answer } = useOrgAgentStore.use.actions();
  const sending = useOrgAgentStore((s) => s.answering.includes(block.question_id));
  return <QuestionCardView block={block} sending={sending} answer={answer} />;
}

// ── Approvals ───────────────────────────────────────────────────────────────

type DecideFrame = Parameters<ReturnType<typeof useOrgAgentStore.getState>["actions"]["decide"]>[0];

/** What the decision sends: the kept rows of a batch, the body only when it
 *  was edited, and for a decline only the reason, when one was given. The
 *  web's `decisionFor`, exactly. */
export function decisionFor(
  approvalId: string,
  card: ApprovalBlock["card"],
  decision: "approve" | "decline",
  selected: readonly boolean[],
  body: string | null,
  reason = "",
): DecideFrame {
  const frame: DecideFrame = { approval_id: approvalId, decision };
  if (decision === "decline") {
    if (reason.trim()) frame.reason = reason.trim().slice(0, 500);
    return frame;
  }
  if (card.rows.length > 1) frame.selected = selected.flatMap((on, i) => (on ? [i] : []));
  if (card.editable_body && body !== null && body !== (card.body ?? "")) frame.edited_body = body;
  return frame;
}

/**
 * The card a member approves before Atlas does anything outward. **Built by
 * the server, never by the model**: the recipients are pinned to ids, and
 * what executes is exactly this card — these rows, this body, or the body as
 * the member edited it. So it is drawn faithfully: the exact body, who will
 * be notified and how, who can read the destination, and the warnings. While
 * it waits it is the decision; once decided it stays as a summary of what
 * was proposed and what came of it.
 */
function ApprovalView({
  block,
  onOpen,
}: {
  block: ApprovalBlock;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  if (block.resolved) return <ApprovalSummary block={block} onOpen={onOpen} />;
  return <ApprovalForm block={block} />;
}

function ApprovalForm({ block }: { block: ApprovalBlock }) {
  const { decide } = useOrgAgentStore.use.actions();
  const deciding = useOrgAgentStore((s) => s.deciding.includes(block.approval_id));
  const connected = useOrgAgentStore((s) => s.connection === "open");
  const { card, approval_id } = block;
  return (
    <ApprovalFormView
      block={block}
      deciding={deciding}
      connected={connected}
      onApprove={(selected, body) =>
        decide(decisionFor(approval_id, card, "approve", selected, body))
      }
      onDecline={(selected, body, reason) =>
        decide(decisionFor(approval_id, card, "decline", selected, body, reason))
      }
    />
  );
}
