// A Deep research job as it runs, and the report it ends in. Props only.

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleSlash,
  FileText,
  Loader2,
  Telescope,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { OrgAgentTarget } from "../../lib/org-agent-links";
import { etaWords, researchFinished, secondsLeft, tookWords } from "../../lib/org-agent-log";
import type { Payload, ResearchStatus, ResearchStep } from "../../lib/org-agent-types";
import { CardList } from "../org-agent-cards";
import { OrgAgentMarkdown } from "../org-agent-markdown";
import { Uncited, useNow } from "./org-agent-turn-parts";
import { Badge, Button } from "@tryatlas/design";

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
export function ResearchProgress({
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
export function ReportView({
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
