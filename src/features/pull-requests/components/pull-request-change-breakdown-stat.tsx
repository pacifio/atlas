// A pull request's line counts, with a hover that splits them into code,
// tests, mocks, generated files and docs. The split comes from the files the
// list's batched read brought back (`pr_list_stats`); until it arrives, or
// when the pull request has too many files to split honestly, the hover says
// so instead.

import { memo } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import {
  CHANGE_KIND_LABELS,
  type ChangedFileKind,
  type PullRequestChangeBreakdown,
} from "../lib/pull-request-change-breakdown";
import { DiffStat } from "./pull-request-presentation";

const KINDS = Object.keys(CHANGE_KIND_LABELS) as ChangedFileKind[];

function BreakdownRow({
  label,
  additions,
  deletions,
}: {
  label: string;
  additions: number;
  deletions: number;
}) {
  return (
    <>
      <span>{label}</span>
      <DiffStat additions={additions} deletions={deletions} className="justify-end" />
    </>
  );
}

function ChangeBreakdownStatImpl({
  additions,
  deletions,
  breakdown,
}: {
  additions: number;
  deletions: number;
  /** `undefined` while unread, `null` when too many files to split. */
  breakdown: PullRequestChangeBreakdown | null | undefined;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="pointer-events-auto inline-flex shrink-0 cursor-default" />}
      >
        <DiffStat additions={additions} deletions={deletions} />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {breakdown ? (
          <div className="grid grid-cols-[auto_auto] items-baseline gap-x-4 gap-y-0.5">
            {KINDS.map((kind) => {
              const counts = breakdown[kind];
              return counts.additions === 0 && counts.deletions === 0 ? null : (
                <BreakdownRow key={kind} label={CHANGE_KIND_LABELS[kind]} {...counts} />
              );
            })}
            <span className="col-span-2 my-0.5 h-px bg-border" />
            <BreakdownRow label="Total" additions={additions} deletions={deletions} />
          </div>
        ) : breakdown === null ? (
          "Too many files to split by kind"
        ) : (
          "Reading the files…"
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export const ChangeBreakdownStat = memo(ChangeBreakdownStatImpl);
