// How a pull request's parts look: its state, a check's status, a review
// verdict, a person, a label, a diff stat. Shared by the header and the
// Summary so the same thing reads the same everywhere.

import { Children, isValidElement, type CSSProperties, type ReactNode } from "react";
import {
  UserCheck,
  UserRound,
  UserX,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import { usePrImage } from "../lib/pr-image";
import type { ReviewOutcome } from "../lib/pull-request-logic";
import type {
  PrActor,
  PrCheckStatus,
  PrChecksState,
  PrLabel,
  PrReviewDecision,
  PrState,
} from "../lib/pull-requests-types";
import { usePullRequestScope } from "./pull-request-context";

// ── state ───────────────────────────────────────────────────────────────

export interface StatePresentation {
  label: string;
  Icon: LucideIcon;
  /** The state's colour, as text. Merged is violet (`chart-4`, the theme's
   *  purple), as GitHub draws it. */
  toneClassName: string;
}

export const STATE_PRESENTATION: Record<PrState | "draft", StatePresentation> = {
  open: { label: "Open", Icon: GitPullRequestArrow, toneClassName: "text-success" },
  draft: { label: "Draft", Icon: GitPullRequestDraft, toneClassName: "text-muted-foreground" },
  closed: { label: "Closed", Icon: GitPullRequestClosed, toneClassName: "text-error" },
  merged: { label: "Merged", Icon: GitMerge, toneClassName: "text-chart-4" },
};

export function resolveStatePresentation(input: {
  state: PrState;
  isDraft: boolean;
}): StatePresentation {
  return STATE_PRESENTATION[input.state === "open" && input.isDraft ? "draft" : input.state];
}

/** The state pill: the state's glyph and word in its colour. */
export function PullRequestStateBadge({ state, isDraft }: { state: PrState; isDraft: boolean }) {
  const presentation = resolveStatePresentation({ state, isDraft });
  return (
    <Badge variant="outline">
      <span className={cn("flex items-center gap-1", presentation.toneClassName)}>
        <presentation.Icon aria-hidden className="size-3" />
        {presentation.label}
      </span>
    </Badge>
  );
}

// ── checks ──────────────────────────────────────────────────────────────

const CHECK_STATUS: Record<PrCheckStatus, { Icon: LucideIcon; toneClassName: string }> = {
  pending: { Icon: Loader2, toneClassName: "animate-spin text-warning" },
  "action-required": { Icon: CircleDot, toneClassName: "text-warning" },
  success: { Icon: CircleCheck, toneClassName: "text-success" },
  failure: { Icon: CircleX, toneClassName: "text-error" },
  cancelled: { Icon: CircleX, toneClassName: "text-error" },
  skipped: { Icon: CircleSlash, toneClassName: "text-muted-foreground" },
  neutral: { Icon: CircleDashed, toneClassName: "text-muted-foreground" },
};

export function CheckStatusIcon({ status }: { status: PrCheckStatus }) {
  const presentation = CHECK_STATUS[status];
  return (
    <presentation.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

export const CHECKS_STATE_PRESENTATION: Record<
  PrChecksState,
  { Icon: LucideIcon; toneClassName: string }
> = {
  passing: { Icon: CircleCheck, toneClassName: "text-success" },
  failing: { Icon: CircleX, toneClassName: "text-error" },
  pending: { Icon: CircleDot, toneClassName: "text-warning" },
};

// ── reviews ─────────────────────────────────────────────────────────────

/** A pull request's review decision as a row signal: approved, changes
 *  requested, or a review still required. */
export const REVIEW_DECISION_PRESENTATION: Record<
  PrReviewDecision,
  { Icon: LucideIcon; toneClassName: string; label: string }
> = {
  approved: { Icon: UserCheck, toneClassName: "text-success", label: "Approved" },
  "changes-requested": { Icon: UserX, toneClassName: "text-error", label: "Changes requested" },
  "review-required": {
    Icon: UserRound,
    toneClassName: "text-muted-foreground",
    label: "Review required",
  },
};

const REVIEW_OUTCOME: Record<
  ReviewOutcome,
  {
    label: string;
    Icon: LucideIcon;
    toneClassName: string;
    ringClassName: string;
    staleRingClassName: string;
    badge: "success" | "destructive" | "outline";
  }
> = {
  approved: {
    label: "Approved",
    Icon: CircleCheck,
    toneClassName: "text-success",
    ringClassName: "ring-2 ring-success",
    staleRingClassName: "ring-2 ring-success-muted",
    badge: "success",
  },
  "changes-requested": {
    label: "Changes requested",
    Icon: CircleX,
    toneClassName: "text-error",
    ringClassName: "ring-2 ring-error",
    staleRingClassName: "ring-2 ring-error-muted",
    badge: "destructive",
  },
  dismissed: {
    label: "Review dismissed",
    Icon: CircleDashed,
    toneClassName: "text-muted-foreground",
    ringClassName: "ring-2 ring-border-strong",
    staleRingClassName: "ring-2 ring-border",
    badge: "outline",
  },
};

export function reviewOutcomeLabel(outcome: ReviewOutcome, stale = false): string {
  return stale ? `${REVIEW_OUTCOME[outcome].label} earlier changes` : REVIEW_OUTCOME[outcome].label;
}

export function reviewOutcomeToneClassName(outcome: ReviewOutcome): string {
  return REVIEW_OUTCOME[outcome].toneClassName;
}

export function reviewOutcomeRingClassName(outcome: ReviewOutcome, stale = false): string {
  return stale ? REVIEW_OUTCOME[outcome].staleRingClassName : REVIEW_OUTCOME[outcome].ringClassName;
}

export function ReviewOutcomeBadge({ outcome }: { outcome: ReviewOutcome }) {
  const presentation = REVIEW_OUTCOME[outcome];
  return (
    <Badge size="sm" variant={presentation.badge}>
      <presentation.Icon aria-hidden className="size-3" />
      {presentation.label}
    </Badge>
  );
}

export function ReviewOutcomeIcon({ outcome }: { outcome: ReviewOutcome }) {
  const presentation = REVIEW_OUTCOME[outcome];
  return <presentation.Icon aria-hidden className={cn("size-3", presentation.toneClassName)} />;
}

// ── people ──────────────────────────────────────────────────────────────

/** An avatar, fetched through the `gh` image proxy (the webview may load no
 *  remote image); the login's first letter until it arrives, or if it
 *  cannot. Every row by one author shares one fetch. */
export function ActorAvatar({ actor, className }: { actor: PrActor | null; className?: string }) {
  const { repoPath } = usePullRequestScope();
  const src = usePrImage(repoPath, actor?.avatarUrl ?? null);
  const login = actor?.login ?? "ghost";
  return src ? (
    <img
      aria-hidden
      alt=""
      src={src}
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground",
        className,
      )}
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function actorTitle(actor: PrActor | null): string {
  const login = actor?.login ?? "ghost";
  return actor?.name && actor.name !== login ? `${actor.name} (@${login})` : login;
}

/** A person: avatar and login, or the avatar alone (`variant="avatar"`). */
export function ActorLabel({
  actor,
  variant = "label",
  tooltip = true,
  className,
}: {
  actor: PrActor | null;
  variant?: "label" | "avatar";
  tooltip?: boolean;
  className?: string;
}) {
  const login = actor?.login ?? "ghost";
  const label = (
    <span className={cn("flex min-w-0 items-center", variant === "label" && "gap-1.5")}>
      <ActorAvatar actor={actor} />
      <span className={variant === "label" ? "truncate font-medium text-foreground" : "sr-only"}>
        {login}
      </span>
    </span>
  );
  const placement = cn("flex min-w-0 shrink", className);
  if (!tooltip) return <span className={placement}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={placement} />}>{label}</TooltipTrigger>
      <TooltipContent side="top">{actorTitle(actor)}</TooltipContent>
    </Tooltip>
  );
}

// ── labels ──────────────────────────────────────────────────────────────

/** A GitHub label's colour, as `#rrggbb`, or `null` for anything else. */
export function labelColor(color: string | null): string | null {
  return color && /^[0-9a-f]{6}$/iu.test(color) ? `#${color}` : null;
}

/** A label: its name on a tint of its own colour. The colour is data the
 *  repository chose, so it arrives as a custom property, never a class. */
export function LabelChip({ label }: { label: Pick<PrLabel, "name" | "color"> }) {
  const color = labelColor(label.color);
  return (
    <span
      className="inline-flex max-w-48 min-w-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-2xs font-medium text-secondary-foreground"
      style={color ? ({ "--pr-label": color } as CSSProperties) : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          color ? "bg-[var(--pr-label)]" : "bg-muted-foreground",
        )}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

// ── numbers ─────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString();
}

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}
      aria-label={`${additions.toLocaleString()} additions, ${deletions.toLocaleString()} deletions`}
    >
      <span className="text-[var(--atlas-diff-added-text)]">+{formatCount(additions)}</span>
      <span className="text-[var(--atlas-diff-removed-text)]">-{formatCount(deletions)}</span>
    </span>
  );
}

function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

/** Inline facts separated by a middle dot. */
export function MetaLine({ children, className }: { children: ReactNode; className?: string }) {
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span aria-hidden className="shrink-0 text-disabled" key={separatorKey(segment)}>
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}
