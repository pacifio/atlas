// One row of the pull-request list: the state glyph (with a conflict mark),
// the number and title, the checks and review signals, and under them the
// author, labels, the stack it sits in, its line counts, comments and when it
// last moved. Clicking opens the pull request in its own tab; Shift shows the
// quick actions at the right.
//
// The row is a stretched button under the content, so the controls inside it
// (the stack popover, the line-count hover, the quick actions) are not
// buttons nested in a button. Content ignores the pointer except where a
// control takes it back.

import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { CircleAlert, Layers, MessageSquare, Search } from "lucide-react";

import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

import type { PullRequestChangeBreakdown } from "../lib/pull-request-change-breakdown";
import type { PullRequestStackMembership } from "../lib/pull-request-list-logic";
import type { PrListEntry } from "../lib/pull-requests-types";
import { ChangeBreakdownStat } from "./pull-request-change-breakdown-stat";
import {
  ActorAvatar,
  actorTitle,
  CHECKS_STATE_PRESENTATION,
  LabelChip,
  resolveStatePresentation,
  REVIEW_DECISION_PRESENTATION,
} from "./pull-request-presentation";
import { PullRequestQuickActions } from "./pull-request-quick-actions";

/** The row's slot height, which the list virtualizes on. */
export const PULL_REQUEST_ROW_HEIGHT = 52;

const CHECKS_LABEL = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
} as const;

function Signal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span title={label} aria-label={label} role="img" className="inline-flex shrink-0">
      {children}
    </span>
  );
}

/** The stack's `2/3`, quiet in the meta line until hovered. */
function StackChip(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="pointer-events-auto relative inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-0.5 hover:text-foreground"
    />
  );
}

/** `2/3` with a popover listing the chain, base first. The list inside is
 *  mounted only while open, so rows in a stack cost one trigger each. */
function StackPopover({
  number,
  membership,
  onOpen,
}: {
  number: number;
  membership: PullRequestStackMembership;
  onOpen: (entry: PrListEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = `Stack, layer ${membership.position} of ${membership.size}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<StackChip aria-label={label} title={label} />}>
        <Layers aria-hidden className="size-2.5" />
        <span className="tabular-nums">
          {membership.position}/{membership.size}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start">
        {open ? (
          <div className="flex flex-col gap-0.5">
            <p className="caption pb-1">Stacked on base branches, base first</p>
            {membership.chain.layers.map((layer, index) => {
              const state = resolveStatePresentation(layer);
              const current = layer.number === number;
              return (
                <button
                  key={layer.number}
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    setOpen(false);
                    if (!current) onOpen(layer);
                  }}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs",
                    current ? "bg-element-selected" : "hover:bg-element-hover",
                  )}
                  style={{
                    paddingLeft: `${0.375 + (membership.chain.depths[index] ?? 0) * 0.75}rem`,
                  }}
                >
                  <state.Icon aria-hidden className={cn("size-3 shrink-0", state.toneClassName)} />
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                    #{layer.number}
                  </span>
                  <span className="min-w-0 truncate text-foreground">{layer.title}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PullRequestListRowImpl({
  entry,
  matchedElsewhere,
  onOpen,
  stack,
  breakdown,
  pending = false,
  sweeping = false,
}: {
  entry: PrListEntry;
  /** A search hit whose match is somewhere the row does not show. */
  matchedElsewhere: boolean;
  onOpen: (entry: PrListEntry) => void;
  /** The chain this pull request sits in, derived from base branches. */
  stack?: PullRequestStackMembership;
  /** The line counts split by kind; `undefined` until read. */
  breakdown?: PullRequestChangeBreakdown | null;
  /** Closing as part of a sweep. */
  pending?: boolean;
  /** Under a close sweep being dragged. */
  sweeping?: boolean;
}) {
  const state = resolveStatePresentation(entry);
  const checks =
    entry.state === "open" && entry.checksState
      ? CHECKS_STATE_PRESENTATION[entry.checksState]
      : null;
  const review =
    entry.state === "open" && entry.reviewDecision
      ? REVIEW_DECISION_PRESENTATION[entry.reviewDecision]
      : null;
  const conflicting = entry.state === "open" && entry.mergeability === "conflicting";
  const label = `${state.label} pull request #${entry.number}: ${entry.title}`;
  return (
    <div
      data-pull-request-number={entry.number}
      className={cn(
        "group/pr-row relative flex h-full w-full min-w-0 items-start gap-2 rounded px-2 py-1.5",
        "hover:bg-element-hover has-[>button:focus-visible]:bg-element-hover",
        (sweeping || pending) && "bg-error-muted hover:bg-error-muted",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(entry)}
        aria-label={label}
        title={entry.url}
        className="absolute inset-0 cursor-pointer rounded focus-visible:outline-none"
      />
      <span className="pointer-events-none relative mt-0.5 inline-flex shrink-0">
        <state.Icon aria-hidden className={cn("size-3.5", state.toneClassName)} />
        {conflicting ? (
          <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-background">
            <Signal label="Has conflicts">
              <CircleAlert aria-hidden className="size-2.5 text-warning" />
            </Signal>
          </span>
        ) : null}
      </span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{entry.number}
          </span>
          <span className="min-w-0 truncate text-xs text-foreground">{entry.title}</span>
          {checks && entry.checksState ? (
            <Signal label={CHECKS_LABEL[entry.checksState]}>
              <checks.Icon aria-hidden className={cn("size-3", checks.toneClassName)} />
            </Signal>
          ) : null}
          {review ? (
            <Signal label={review.label}>
              <review.Icon aria-hidden className={cn("size-3", review.toneClassName)} />
            </Signal>
          ) : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          {matchedElsewhere ? (
            <span
              title="Matched in the description"
              className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1"
            >
              <Search aria-hidden className="size-2.5" />
              <span className="sr-only">Matched in the description</span>
            </span>
          ) : null}
          <span title={actorTitle(entry.author)} className="flex min-w-0 items-center gap-1">
            <ActorAvatar actor={entry.author} className="size-3.5" />
            <span className="truncate">{entry.author?.login ?? "ghost"}</span>
          </span>
          {entry.labels.slice(0, 2).map((labelEntry) => (
            <span key={labelEntry.name} className="hidden min-w-0 shrink @sm/pr-list:inline-flex">
              <LabelChip label={labelEntry} />
            </span>
          ))}
          {entry.labels.length > 2 ? (
            <span className="hidden shrink-0 @sm/pr-list:inline">+{entry.labels.length - 2}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            {stack ? (
              <StackPopover number={entry.number} membership={stack} onOpen={onOpen} />
            ) : null}
            <ChangeBreakdownStat
              additions={entry.additions}
              deletions={entry.deletions}
              breakdown={breakdown}
            />
            {entry.commentCount > 0 ? (
              <span
                className="flex items-center gap-0.5"
                title={`${entry.commentCount} comment${entry.commentCount === 1 ? "" : "s"}`}
              >
                <MessageSquare aria-hidden className="size-2.5" />
                {entry.commentCount}
              </span>
            ) : null}
            <span title={new Date(entry.updatedAt).toLocaleString()}>
              {timeAgo(entry.updatedAt)}
            </span>
          </span>
        </span>
      </span>
      <span className="relative self-center">
        <PullRequestQuickActions entry={entry} pending={pending} sweeping={sweeping} />
      </span>
    </div>
  );
}

export const PullRequestListRow = memo(PullRequestListRowImpl);
