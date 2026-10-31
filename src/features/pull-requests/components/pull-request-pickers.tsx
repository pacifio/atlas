// The Summary's reviewer and label pickers: a search box over the
// repository's candidates, each row toggling one person or label. The
// candidates are read only while a picker is open, and a picker the viewer
// may not use explains why instead of opening.

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Tag, UserPlus, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Hint } from "@/ui/tooltip";

import { classifyPrError, prErrorMessage } from "../lib/pr-errors";
import {
  usePrLabelCandidates,
  usePrLabelsMutation,
  usePrReviewerCandidates,
  usePrReviewersMutation,
} from "../lib/pull-requests-queries";
import type { PrError, PrLabelCandidate, PrReviewerCandidate } from "../lib/pull-requests-types";
import { readableFailure } from "../lib/use-pull-request-actions";
import { usePullRequestScope } from "./pull-request-context";
import { ActorLabel, labelColor } from "./pull-request-presentation";
import { PeopleGhost } from "./pull-request-states";

function CandidatePicker<T>({
  icon,
  label,
  allowed,
  disabledReason,
  open,
  onOpenChange,
  searchLabel,
  query,
  onQueryChange,
  isPending,
  error,
  candidates,
  emptyLabel,
  noMatchLabel,
  errorLabel,
  truncated,
  truncatedLabel,
  candidateKey,
  disabled,
  onSelect,
  children,
}: {
  icon: LucideIcon;
  label: string;
  allowed: boolean;
  disabledReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  isPending: boolean;
  error: PrError | null;
  candidates: readonly T[];
  emptyLabel: string;
  noMatchLabel: string;
  errorLabel: string;
  truncated: boolean;
  truncatedLabel: string;
  candidateKey: (candidate: T) => string;
  disabled: boolean;
  onSelect: (candidate: T) => void;
  children: (candidate: T) => ReactNode;
}) {
  const [active, setActive] = useState(0);
  if (!allowed) {
    return (
      <Hint label={disabledReason}>
        <IconButton icon={icon} label={label} size="xs" aria-disabled="true" />
      </Hint>
    );
  }
  const highlighted = Math.min(active, Math.max(0, candidates.length - 1));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onQueryChange("");
      }}
    >
      <PopoverTrigger render={<IconButton icon={icon} label={label} size="xs" />} />
      <PopoverContent align="start" side="bottom" className="w-72 p-1.5">
        <Input
          size="sm"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the popover opens to search
          autoFocus
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive(Math.min(highlighted + 1, candidates.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive(Math.max(highlighted - 1, 0));
            } else if (event.key === "Enter" && candidates[highlighted] && !disabled) {
              event.preventDefault();
              onSelect(candidates[highlighted]);
            }
          }}
        />
        <div role="listbox" aria-label={label} className="mt-1 max-h-72 overflow-y-auto">
          {isPending ? (
            <PeopleGhost rows={4} />
          ) : error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              {errorLabel} {prErrorMessage(error)}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0 ? noMatchLabel : emptyLabel}
            </p>
          ) : (
            candidates.map((candidate, index) => (
              <button
                key={candidateKey(candidate)}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                disabled={disabled}
                onPointerEnter={() => setActive(index)}
                onClick={() => onSelect(candidate)}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs text-secondary-foreground disabled:cursor-wait disabled:opacity-60",
                  index === highlighted && "bg-element-hover text-foreground",
                )}
              >
                {children(candidate)}
              </button>
            ))
          )}
          {truncated ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{truncatedLabel}</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function matchesPerson(candidate: PrReviewerCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    candidate.actor.login.toLowerCase().includes(needle) ||
    (candidate.actor.name ?? "").toLowerCase().includes(needle)
  );
}

export function ReviewerPicker({ allowed }: { allowed: boolean }) {
  const { repoPath, number } = usePullRequestScope();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const read = usePrReviewerCandidates(repoPath, number, open);
  const mutation = usePrReviewersMutation(repoPath, number);
  const candidates = (read.data?.candidates ?? []).filter((c) => matchesPerson(c, query));

  const toggle = (candidate: PrReviewerCandidate) => {
    const name = candidate.actor.login;
    mutation.mutate(
      {
        reviewers: [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
      {
        onSuccess: () =>
          toast.success(
            candidate.isRequested
              ? `Review request to ${name} taken back`
              : `Review requested from ${name}`,
          ),
        onError: (raw) =>
          toast.error(
            candidate.isRequested
              ? `Could not take back the review request to ${name}`
              : `Could not ask ${name} for a review`,
            {
              description: readableFailure(
                classifyPrError(raw),
                "GitHub refused it. Check that you have write access, and that they still have access to the repository.",
              ),
            },
          ),
      },
    );
  };

  return (
    <CandidatePicker
      icon={UserPlus}
      label="Request a review"
      allowed={allowed}
      disabledReason="Asking for a review needs write access to this repository"
      open={open}
      onOpenChange={setOpen}
      searchLabel="Search people with access"
      query={query}
      onQueryChange={setQuery}
      isPending={read.isPending}
      error={read.data ? null : (read.error ?? null)}
      candidates={candidates}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncated={read.data?.truncated === true}
      truncatedLabel="More people have access than are listed here; ask the rest on GitHub."
      candidateKey={(c) => `${c.kind}:${c.id}`}
      disabled={mutation.isPending}
      onSelect={toggle}
    >
      {(candidate) => (
        <>
          <ActorLabel actor={candidate.actor} tooltip={false} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">team</span>
          ) : null}
          {candidate.isRequested ? (
            <Check aria-label="Already asked" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </CandidatePicker>
  );
}

function matchesLabel(candidate: PrLabelCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function LabelPicker({ allowed }: { allowed: boolean }) {
  const { repoPath, number } = usePullRequestScope();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const read = usePrLabelCandidates(repoPath, number, open);
  const mutation = usePrLabelsMutation(repoPath, number);
  const candidates = (read.data?.candidates ?? []).filter((c) => matchesLabel(c, query));

  const toggle = (candidate: PrLabelCandidate) => {
    mutation.mutate(
      { labels: [candidate.name], applied: !candidate.isApplied },
      {
        onError: (raw) =>
          toast.error(
            candidate.isApplied
              ? `Could not take ${candidate.name} off`
              : `Could not put ${candidate.name} on`,
            {
              description: readableFailure(
                classifyPrError(raw),
                "GitHub refused it. Check that you have triage access to this repository.",
              ),
            },
          ),
      },
    );
  };

  return (
    <CandidatePicker
      icon={Tag}
      label="Change labels"
      allowed={allowed}
      disabledReason="Changing labels needs triage access to this repository"
      open={open}
      onOpenChange={setOpen}
      searchLabel="Search labels"
      query={query}
      onQueryChange={setQuery}
      isPending={read.isPending}
      error={read.data ? null : (read.error ?? null)}
      candidates={candidates}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={read.data?.truncated === true}
      truncatedLabel="The repository has more labels than are listed here; apply the rest on GitHub."
      candidateKey={(c) => c.name}
      disabled={mutation.isPending}
      onSelect={toggle}
    >
      {(candidate) => {
        const color = labelColor(candidate.color);
        return (
          <>
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                color ? "bg-[var(--pr-label)]" : "bg-muted-foreground",
              )}
              style={color ? ({ "--pr-label": color } as React.CSSProperties) : undefined}
            />
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
              ) : null}
            </span>
            {candidate.isApplied ? (
              <Check aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </CandidatePicker>
  );
}
