// One exchange with the agent: what the member asked (their bubble, with the
// things they mentioned as chips), then what Atlas did in the order it did it
// — its plan, the tools it ran and the records they returned, its words, the
// approvals it asked for, the questions it put — and how the turn ended. The
// actions arrive once it has ended: copy, rate, ask again.
//
// The web's `conversation.tsx`, `approval-card.tsx` and `research.tsx`, drawn
// in the desktop's coding-chat idiom: the question is the chat's bubble, the
// answer is prose on the page, tool calls are quiet lines.

import { useEffect, useState } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  CircleSlash,
  Copy,
  Eye,
  FileText,
  Gauge,
  Loader2,
  RotateCcw,
  Telescope,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Input } from "@/ui/input";

import type { OrgAgentTarget } from "../lib/org-agent-links";
import { mentionTarget } from "../lib/org-agent-links";
import {
  etaWords,
  lastOf,
  researchFinished,
  secondsLeft,
  tookWords,
  turnEnded,
  turnText,
  type ApprovalBlock,
  type Block,
  type QuestionBlock,
  type ToolBlock,
  type Turn,
} from "../lib/org-agent-log";
import { segmentsOf } from "../lib/org-agent-mentions";
import type {
  AskStatus,
  LimitWhich,
  Mention,
  Payload,
  PlanStep,
  ResearchStatus,
  ResearchStep,
} from "../lib/org-agent-types";
import { useOrgAgentStore, type PendingSend } from "../stores/org-agent-store";
import { CardList } from "./org-agent-cards";
import { OrgAgentMarkdown } from "./org-agent-markdown";

/** A clock that ticks while something is counting down. */
function useNow(active: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

// ── The member's words ──────────────────────────────────────────────────────

/** The member's message: the coding chat's bubble, mentions as chips that
 *  open what they name. */
export function PromptBubble({
  text,
  mentions,
  effort,
  deepResearch,
  pending,
  onOpen,
}: {
  text: string;
  mentions?: Mention[];
  effort?: string;
  deepResearch?: boolean;
  pending?: boolean;
  onOpen?: (target: OrgAgentTarget) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1 pl-10">
      <div
        className={cn(
          // ratchet-allow: 20px sits above the `rounded-*` scale (xl = 12px), and
          // a full radius would turn a many-line bubble into an ellipse.
          "min-w-0 max-w-full rounded-[20px] bg-[var(--atlas-primary-muted)] px-4 py-2.5 text-sm whitespace-pre-wrap break-words text-foreground select-text",
          pending && "opacity-70",
        )}
      >
        {segmentsOf(text, mentions).map((seg, i) => {
          if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
          const target = onOpen ? mentionTarget(seg.mention) : null;
          return target ? (
            <button
              key={i}
              type="button"
              onClick={() => onOpen!(target)}
              className="atlas-mention-chip cursor-pointer align-baseline"
              title={seg.mention.handle ?? seg.mention.kind}
            >
              <span className="atlas-mention-chip__label">{seg.text}</span>
            </button>
          ) : (
            <span key={i} className="atlas-mention-chip align-baseline" title={seg.mention.kind}>
              <span className="atlas-mention-chip__label">{seg.text}</span>
            </span>
          );
        })}
      </div>
      {(effort || deepResearch) && (
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          {deepResearch ? <Telescope size={10} /> : <Gauge size={10} />}
          {deepResearch ? "Deep research" : (EFFORT_LABEL[effort!] ?? effort)}
        </span>
      )}
    </div>
  );
}

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

type Group = { kind: "tools"; tools: ToolBlock[] } | { kind: "block"; block: Block };

/** Consecutive tool calls read as one list of steps, not a card each. */
function groupBlocks(blocks: readonly Block[]): Group[] {
  const out: Group[] = [];
  for (const block of blocks) {
    const last = lastOf(out);
    if (block.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(block);
      else out.push({ kind: "tools", tools: [block] });
    } else {
      out.push({ kind: "block", block });
    }
  }
  return out;
}

/** What Atlas looked at: one line per call, folded once there are several,
 *  and the records each returned under it. */
function ToolSteps({
  tools,
  live,
  onOpen,
}: {
  tools: readonly ToolBlock[];
  live: boolean;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const running = tools.some((t) => !t.done);
  const [open, setOpen] = useState(false);
  const shown = open || running || tools.length <= 2;
  const records = tools.reduce((n, t) => n + t.cards.length, 0);
  return (
    <div className="flex flex-col gap-1.5" data-slot="org-agent-tools">
      {!shown ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex cursor-pointer items-center gap-1.5 self-start text-2xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight size={11} />
          Looked at {tools.length} things
          {records > 0 ? ` · ${records} ${records === 1 ? "record" : "records"}` : ""}
        </button>
      ) : (
        <>
          {tools.length > 2 && !running && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex cursor-pointer items-center gap-1.5 self-start text-2xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown size={11} />
              Looked at {tools.length} things
            </button>
          )}
          <ul className="flex flex-col gap-1">
            {tools.map((t) => (
              <li key={t.call_id} className="flex flex-col gap-1.5">
                <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                  {t.done ? (
                    <Check size={11} className="shrink-0" />
                  ) : live ? (
                    <Loader2 size={11} className="shrink-0 animate-spin" />
                  ) : (
                    <CircleSlash size={11} className="shrink-0" />
                  )}
                  <span className="min-w-0 truncate" title={t.tool}>
                    {t.summary}
                  </span>
                  {t.done && t.cards.length > 0 && (
                    <span className="shrink-0 tabular-nums">· {t.cards.length}</span>
                  )}
                </span>
                {t.cards.length > 0 && (
                  <CardList cards={t.cards} truncated={t.truncated} onOpen={onOpen} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const STEP_ICON: Record<PlanStep["status"], LucideIcon> = {
  pending: Circle,
  in_progress: Loader2,
  done: Check,
  canceled: CircleSlash,
};

/** Atlas's plan for a longer answer, replaced whole as it moves. */
function PlanList({ steps }: { steps: readonly PlanStep[] }) {
  return (
    <ol
      aria-label="Plan"
      className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2"
    >
      {steps.map((s, i) => {
        const Glyph = STEP_ICON[s.status];
        return (
          <li
            key={i}
            className={cn(
              "flex items-center gap-2 text-xs",
              s.status === "done" || s.status === "canceled"
                ? "text-muted-foreground"
                : "text-foreground",
              s.status === "canceled" && "line-through",
            )}
          >
            <Glyph
              size={11}
              className={cn("shrink-0", s.status === "in_progress" && "animate-spin")}
            />
            {s.text}
          </li>
        );
      })}
    </ol>
  );
}

function WorkingLabel({ label, left }: { label: string; left?: string | null }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground" />
      <span className="animate-pulse">{label}</span>
      {left && <span className="tabular-nums">· {left}</span>}
    </p>
  );
}

/** What Atlas is doing now, and the estimate of what is left, counted down
 *  between `eta` events so it moves. */
function WorkingLine({ turn, status }: { turn: Turn; status: AskStatus }) {
  const now = useNow(status === "running");
  const left = status === "running" ? etaWords(secondsLeft(turn.eta, now)) : null;
  const running = [...turn.blocks]
    .reverse()
    .find((b): b is ToolBlock => b.kind === "tool" && !b.done);
  const label =
    status === "waiting_approval"
      ? "Waiting for your approval"
      : status === "waiting_answer"
        ? "Waiting for your answer"
        : running
          ? "Reading"
          : turn.blocks.some((b) => b.kind === "text")
            ? "Writing"
            : "Thinking";
  return <WorkingLabel label={label} left={left} />;
}

const LIMIT_TEXT: Record<LimitWhich, string> = {
  rounds: "Atlas stopped here to keep this answer from running on.",
  tool_calls: "Atlas stopped after looking at a lot of records.",
  wall_time: "Atlas stopped because this answer was taking too long.",
  budget: "Your organisation's AI budget is used up for now.",
  rate: "Atlas is getting too many requests right now. Try again in a minute.",
  model_off: "The model Atlas uses is not available for your organisation.",
  turns_per_day: "You have asked Atlas as many questions as you can today.",
  deep_research_per_day:
    "You have used today's Deep research. It resets at midnight UTC; ask without it in the meantime.",
};

function LimitNotice({
  which,
  canContinue,
  onContinue,
}: {
  which: LimitWhich;
  canContinue: boolean;
  onContinue: () => void;
}) {
  return (
    <Notice tone="warning">
      <span className="min-w-0 flex-1">{LIMIT_TEXT[which] ?? "Atlas stopped here."}</span>
      {canContinue && (
        <Button size="xs" variant="outline" onClick={onContinue}>
          Continue
        </Button>
      )}
    </Notice>
  );
}

function Uncited({ count }: { count: number }) {
  return (
    <p className="text-2xs text-muted-foreground">
      {count === 1
        ? "One reference could not be checked against what Atlas read, so it is not linked."
        : `${count} references could not be checked against what Atlas read, so they are not linked.`}
    </p>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "error" | "warning" | "info";
  children: React.ReactNode;
}) {
  const Glyph = tone === "error" ? TriangleAlert : tone === "warning" ? TriangleAlert : Eye;
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "error" && "border-error bg-error-muted text-foreground",
        tone === "warning" && "border-warning bg-warning-muted text-foreground",
        tone === "info" && "border-border bg-card text-secondary-foreground",
      )}
    >
      <Glyph
        size={13}
        className={cn(
          "shrink-0",
          tone === "error" && "text-error",
          tone === "warning" && "text-warning",
          tone === "info" && "text-muted-foreground",
        )}
      />
      {children}
    </div>
  );
}

function TurnActions({
  copy,
  vote,
  onVote,
  onRegenerate,
  worked,
}: {
  copy: string;
  vote: "up" | "down" | null;
  onVote?: (rating: "up" | "down") => void;
  onRegenerate?: () => void;
  worked: number | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <HintGroup side="bottom">
      <div className="-ml-1.5 flex items-center gap-0.5 text-muted-foreground">
        <Action
          label={copied ? "Copied" : "Copy"}
          icon={copied ? Check : Copy}
          onClick={() => void copyText(copy).then(setCopied)}
        />
        {onVote && (
          <>
            <Action
              label="Good answer"
              icon={ThumbsUp}
              on={vote === "up"}
              onClick={() => onVote("up")}
            />
            <Action
              label="Bad answer"
              icon={ThumbsDown}
              on={vote === "down"}
              onClick={() => onVote("down")}
            />
          </>
        )}
        {onRegenerate && <Action label="Ask again" icon={RotateCcw} onClick={onRegenerate} />}
        {worked !== null && worked > 0 && (
          <span className="ml-1.5 text-2xs tabular-nums">Worked for {tookWords(worked)}</span>
        )}
      </div>
    </HintGroup>
  );
}

function Action({
  label,
  icon: Glyph,
  on,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  on?: boolean;
  onClick: () => void;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        onClick={onClick}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors duration-fast hover:bg-element-hover hover:text-foreground",
          on && "text-foreground",
        )}
      >
        <Glyph size={13} fill={on ? "currentColor" : "none"} />
      </button>
    </HintItem>
  );
}

// ── Questions ───────────────────────────────────────────────────────────────

/** A question Atlas asked: its choices as buttons, and a line of free text
 *  when it allows one. */
function QuestionView({ block }: { block: QuestionBlock }) {
  const { answer } = useOrgAgentStore.use.actions();
  const sending = useOrgAgentStore((s) => s.answering.includes(block.question_id));
  const [text, setText] = useState("");
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      data-slot="org-agent-question"
    >
      <p className="text-sm text-foreground">{block.text}</p>
      {block.answered ? (
        <p className="text-2xs text-muted-foreground">Answered.</p>
      ) : sending ? (
        <p className="flex items-center gap-2 text-2xs text-muted-foreground" aria-live="polite">
          <Loader2 size={11} className="animate-spin" />
          Sending your answer
        </p>
      ) : (
        <>
          {block.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {block.options.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant="outline"
                  onClick={() => answer(block.question_id, { choice: o.id })}
                >
                  {o.label}
                </Button>
              ))}
            </div>
          )}
          {block.allow_text && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) answer(block.question_id, { text: text.trim() });
              }}
            >
              <Input
                aria-label="Your answer"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Or type an answer"
                className="flex-1"
              />
              <Button type="submit" size="sm" disabled={!text.trim()}>
                Answer
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────

const HOW: Record<string, string> = { dm: "direct message", mention: "mention", digest: "digest" };

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
  const [selected, setSelected] = useState(() => card.rows.map((r) => r.selected));
  const [body, setBody] = useState<string | null>(card.editable_body ? (card.body ?? "") : null);
  const [pressed, setPressed] = useState<"approve" | "decline" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const batch = card.rows.length > 1;
  const fact = card.tool === "propose_fact";
  const none = batch && !selected.some(Boolean);
  const canConfirm = connected && !deciding && !none && (body === null || body.trim().length > 0);
  const confirm = () => {
    if (!canConfirm) return;
    setPressed("approve");
    decide(decisionFor(approval_id, card, "approve", selected, body));
  };
  const decline = () => {
    if (deciding || !connected) return;
    setPressed("decline");
    decide(decisionFor(approval_id, card, "decline", selected, body, reason));
  };

  return (
    <section
      aria-label="Approval needed"
      data-slot="org-agent-approval"
      className="flex flex-col gap-3 rounded-xl border border-border-strong bg-card p-3 shadow-sm"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        const el = e.target as HTMLElement;
        if (el.dataset.slot === "decline-reason") {
          e.preventDefault();
          decline();
          return;
        }
        const inField = el.tagName === "TEXTAREA";
        if ((inField && !(e.metaKey || e.ctrlKey)) || (!inField && el.closest("button"))) return;
        e.preventDefault();
        confirm();
      }}
    >
      <header className="flex items-center gap-2">
        <Badge variant="warning">Needs your approval</Badge>
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{card.title}</h3>
      </header>

      {card.warnings.map((w, i) =>
        w.kind === "external_content" ? (
          <Notice key={i} tone="error">
            {w.note}
          </Notice>
        ) : (
          <Notice key={i} tone="warning">
            {w.note}
          </Notice>
        ),
      )}

      {batch ? (
        <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border">
          {card.rows.map((row, i) => (
            <li key={`${row.target.kind}:${row.target.id}`}>
              <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected[i] ?? false}
                  onChange={(e) =>
                    setSelected((s) => s.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                  disabled={deciding}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{row.target.name}</span>
                  {row.body && (
                    <span className="mt-0.5 block whitespace-pre-wrap break-words text-2xs text-muted-foreground">
                      {row.body}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        card.rows[0] && (
          <p className="text-xs text-muted-foreground">
            {fact ? "About" : "To"}{" "}
            <span className="font-medium text-foreground">{card.rows[0].target.name}</span>
          </p>
        )
      )}

      {body !== null ? (
        <textarea
          aria-label={fact ? "Fact" : "Message"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={deciding}
          rows={Math.min(10, Math.max(3, body.split("\n").length))}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:border-border-strong"
        />
      ) : (
        card.body && (
          <p className="max-h-60 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-foreground">
            {card.body}
          </p>
        )
      )}

      {card.loop && (
        <dl
          data-slot="loop-setup"
          className="flex flex-col gap-1 rounded-md bg-element-hover px-2.5 py-2 text-2xs"
        >
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Runs</dt>
            <dd className="text-foreground">{card.loop.trigger}</dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Result goes to</dt>
            <dd className="text-foreground">{card.loop.output}</dd>
          </div>
          <div className="flex flex-wrap gap-x-1.5">
            <dt className="text-muted-foreground">Reads</dt>
            <dd className="text-foreground">{card.loop.audience}</dd>
          </div>
        </dl>
      )}

      {card.sources && card.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-2xs text-muted-foreground">Sources</p>
          <ul aria-label="Sources" className="flex flex-wrap gap-1.5">
            {card.sources.map((s) => (
              <li
                key={`${s.kind}:${s.ref}`}
                className="rounded-full bg-element-hover px-2 py-0.5 font-mono text-2xs"
              >
                {s.label ?? s.ref}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="flex flex-col gap-1 text-2xs text-muted-foreground">
        {card.notifies.length > 0 && (
          <div className="flex items-start gap-1.5">
            <dt className="flex shrink-0 items-center pt-px">
              <Bell size={11} />
              <span className="sr-only">Notifies</span>
            </dt>
            <dd className="min-w-0">
              Notifies {card.notifies.map((n) => `${n.name} (${HOW[n.how] ?? n.how})`).join(", ")}
            </dd>
          </div>
        )}
        <div className="flex items-start gap-1.5">
          <dt className="flex shrink-0 items-center pt-px">
            <Eye size={11} />
            <span className="sr-only">Visible to</span>
          </dt>
          <dd className="min-w-0">Visible to {card.visible_to.description}</dd>
        </div>
      </dl>

      {declining && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-slot="decline-reason"
            aria-label="Reason for declining"
            placeholder="Tell Atlas why (optional)"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            disabled={deciding}
            autoFocus
            className="min-w-0 flex-1 basis-48"
          />
          <Button variant="ghost" size="sm" onClick={() => setDeclining(false)} disabled={deciding}>
            Back
          </Button>
          <Button size="sm" variant="secondary" onClick={decline} disabled={deciding}>
            {deciding && pressed === "decline" ? "Declining…" : "Decline"}
          </Button>
        </div>
      )}

      <footer className="flex items-center justify-end gap-2 border-t border-border-subtle pt-2.5">
        {!connected && (
          <span className="mr-auto text-2xs text-muted-foreground">Reconnecting…</span>
        )}
        {!declining && (
          <Button variant="ghost" size="sm" onClick={() => setDeclining(true)} disabled={deciding}>
            Decline
          </Button>
        )}
        <Button
          size="sm"
          onClick={confirm}
          disabled={!canConfirm || declining}
          aria-busy={deciding && pressed === "approve"}
        >
          {deciding && pressed === "approve"
            ? "Working…"
            : fact
              ? "Save"
              : card.tool === "loop_create"
                ? "Create Loop"
                : "Confirm"}
        </Button>
      </footer>
    </section>
  );
}

/** An approval once decided: what was proposed, and what came of it. */
function ApprovalSummary({
  block,
  onOpen,
}: {
  block: ApprovalBlock;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const { card, resolved } = block;
  const target =
    card.rows.length > 1 ? `${card.rows.length} recipients` : (card.rows[0]?.target.name ?? "");
  return (
    <div className="flex flex-col gap-2" data-slot="org-agent-approval-summary">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{card.title}</span>
        {target && <span>· {target}</span>}
        {resolved === null ? (
          <Badge variant="warning">Waiting for you</Badge>
        ) : resolved.withdrawn ? (
          <Badge variant="outline">Withdrawn</Badge>
        ) : resolved.decision === "decline" ? (
          <Badge variant="outline">Declined</Badge>
        ) : resolved.outcome_unknown ? (
          <Badge variant="warning">Outcome unknown</Badge>
        ) : resolved.executed && !resolved.executed.ok ? (
          <Badge variant="destructive">Failed</Badge>
        ) : (
          <Badge variant="success">
            <Check size={10} />
            Done
          </Badge>
        )}
      </div>
      {resolved?.outcome_unknown && (
        <p className="text-2xs text-muted-foreground">
          Atlas could not confirm whether this went through. Check before trying again.
        </p>
      )}
      {resolved?.executed && resolved.executed.cards.length > 0 && (
        <CardList cards={resolved.executed.cards} onOpen={onOpen} />
      )}
    </div>
  );
}

// ── Deep research ───────────────────────────────────────────────────────────

const PHASE_WORDS: Record<ResearchStatus, string> = {
  queued: "Starting",
  planning: "Planning the research",
  researching: "Researching",
  writing: "Writing the report",
  done: "Report ready",
  canceled: "Canceled",
  failed: "Could not finish",
};

const RESEARCH_STEP_ICON: Record<ResearchStep["status"], LucideIcon> = {
  pending: Circle,
  running: Loader2,
  done: Check,
  failed: TriangleAlert,
  skipped: CircleSlash,
};

/** A Deep research job while it runs: the question, the phase, the plan's
 *  sub-questions as a checklist, the estimate counting down, and Cancel. It
 *  runs on the server whatever this window does, which the footer says. */
function ResearchProgress({
  research,
  onCancel,
  cancelable,
}: {
  research: Payload<"research"> & { at: number };
  onCancel: () => void;
  cancelable: boolean;
}) {
  const finished = researchFinished(research.status);
  const now = useNow(!finished);
  const left = finished
    ? null
    : etaWords(secondsLeft({ seconds_left: research.eta.seconds_left, at: research.at }, now));
  const done = research.steps.filter((s) => s.status === "done").length;
  return (
    <section
      aria-label="Deep research"
      data-slot="org-agent-research"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Telescope size={13} className="shrink-0 text-info" />
        <span className="text-2xs text-muted-foreground">Deep research</span>
        <span
          className="flex min-w-0 items-center gap-1.5 text-xs text-foreground"
          aria-live="polite"
        >
          {!finished && <Loader2 size={11} className="animate-spin" />}
          {PHASE_WORDS[research.status]}
          {research.steps.length > 0 && research.status === "researching" && (
            <span className="tabular-nums text-muted-foreground">
              {done} of {research.steps.length}
            </span>
          )}
        </span>
        {left && (
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
            {left}
          </span>
        )}
      </header>
      {research.steps.length > 0 && (
        <ol aria-label="Research plan" className="flex flex-col gap-1.5">
          {research.steps.map((s) => {
            const Glyph = RESEARCH_STEP_ICON[s.status];
            return (
              <li
                key={s.id}
                className={cn(
                  "flex items-start gap-2 text-xs",
                  s.status === "pending" || s.status === "skipped"
                    ? "text-muted-foreground"
                    : "text-foreground",
                  s.status === "skipped" && "line-through",
                )}
              >
                <Glyph
                  size={11}
                  className={cn(
                    "mt-0.5 shrink-0",
                    s.status === "running" && !finished && "animate-spin",
                    s.status === "done" && "text-success",
                    s.status === "failed" && "text-warning",
                  )}
                />
                <span className="min-w-0 flex-1">{s.question}</span>
                {s.status === "running" && (s.tool_calls ?? 0) > 0 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {s.tool_calls} reads
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {research.note && (research.status === "failed" || research.status === "canceled") && (
        <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          {research.note}
        </p>
      )}
      {!finished && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2.5">
          <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
            You can close this. The report will arrive here and in your notifications.
          </p>
          {cancelable && (
            <Button size="xs" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}

/** The finished report: a titled document, its citations linked like any
 *  answer's, the plan it followed folded below. */
function ReportView({
  report,
  handles,
  onOpen,
}: {
  report: Payload<"report">;
  handles: ReadonlyMap<string, OrgAgentTarget>;
  onOpen: (target: OrgAgentTarget) => void;
}) {
  const [steps, setSteps] = useState(false);
  const answered = report.steps.filter((s) => s.status === "done").length;
  return (
    <section
      aria-label={`Report: ${report.title}`}
      data-slot="org-agent-report"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex min-w-0 flex-col gap-1">
        <p className="flex items-center gap-1.5">
          <FileText size={11} className="text-info" />
          <span className="text-2xs text-muted-foreground">Research report</span>
          {report.partial && (
            <Badge variant="warning" size="sm" className="ml-1">
              Partial
            </Badge>
          )}
        </p>
        <h3 className="text-md font-semibold text-foreground">{report.title}</h3>
        <p className="text-2xs tabular-nums text-muted-foreground">
          {answered} of {report.steps.length} questions answered · {tookWords(report.duration_ms)}
          {report.cards.length > 0 ? ` · ${report.cards.length} sources` : ""}
        </p>
      </header>
      {report.partial && (
        <p className="text-2xs text-muted-foreground">
          Written from what was found so far, so some questions may be left open.
        </p>
      )}
      <OrgAgentMarkdown source={report.text} handles={handles} onOpen={onOpen} />
      {report.uncited.length > 0 && <Uncited count={report.uncited.length} />}
      <div className="flex flex-col gap-2 border-t border-border-subtle pt-2.5">
        <button
          type="button"
          onClick={() => setSteps(!steps)}
          className="flex cursor-pointer items-center gap-1.5 self-start text-2xs text-muted-foreground hover:text-foreground"
        >
          {steps ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          The plan it followed
        </button>
        {steps && (
          <ol className="flex flex-col gap-1">
            {report.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-2xs text-muted-foreground">
                <span className="w-14 shrink-0">{s.status}</span>
                <span className="min-w-0 flex-1 text-foreground">{s.question}</span>
              </li>
            ))}
          </ol>
        )}
        {report.cards.length > 0 && <CardList cards={report.cards} onOpen={onOpen} />}
      </div>
    </section>
  );
}
