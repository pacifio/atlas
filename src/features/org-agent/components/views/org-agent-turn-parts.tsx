// The pieces of one exchange with the agent that render from props alone:
// the member's bubble, the tool steps, the plan, the working line, the
// notices and the actions. `org-agent-turn.tsx` wires them to the store.

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleSlash,
  Copy,
  Eye,
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
import { Button } from "@/ui/button";
import { HintGroup, HintItem } from "@/ui/hint-group";

import type { OrgAgentTarget } from "../../lib/org-agent-links";
import { mentionTarget } from "../../lib/org-agent-links";
import {
  etaWords,
  lastOf,
  secondsLeft,
  tookWords,
  type Block,
  type ToolBlock,
  type Turn,
} from "../../lib/org-agent-log";
import { segmentsOf } from "../../lib/org-agent-mentions";
import type { AskStatus, LimitWhich, Mention, PlanStep } from "../../lib/org-agent-types";
import { CardList } from "../org-agent-cards";

/** A clock that ticks while something is counting down. */
export function useNow(active: boolean, ms = 1_000): number {
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

export type Group = { kind: "tools"; tools: ToolBlock[] } | { kind: "block"; block: Block };

/** Consecutive tool calls read as one list of steps, not a card each. */
export function groupBlocks(blocks: readonly Block[]): Group[] {
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
export function ToolSteps({
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
export function PlanList({ steps }: { steps: readonly PlanStep[] }) {
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

export function WorkingLabel({ label, left }: { label: string; left?: string | null }) {
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
export function WorkingLine({ turn, status }: { turn: Turn; status: AskStatus }) {
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

export function LimitNotice({
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

export function Uncited({ count }: { count: number }) {
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

export function TurnActions({
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
