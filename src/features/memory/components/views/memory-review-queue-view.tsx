// The Review tab, props-only: what waits for the user, one decision at a
// time. The item in front is a card with its choices; the rest wait below
// as one line each, and any can be brought forward. "Later" sends the front
// item to the back of the queue without deciding it.
//
// Nothing here is automatic: every action is the user's, and a dismissed or
// merged memory is archived, never deleted (its history stays).
//
// The next card arrives with the session rows' entrance (`session-row-in`):
// it confirms the last choice landed and says where the eye goes next. Keyed
// by item, so a fast run of choices restarts it rather than queueing it, and
// the package turns it off under reduced motion.

import { CheckCircle2, GitBranch, GitMerge, Inbox, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, EmptyState, Skeleton } from "@tryatlas/design";
import { kindNoun } from "../../lib/memory-entries";
import { REVIEW_EYEBROW, dreamLabel, type ReviewItem } from "../../lib/memory-review-items";
import { confidenceLabel, type MemoryEntry } from "../../lib/shared-memory-format";
import { EntryAuthor, KindGlyph } from "./memory-entry-parts";
import { Notice } from "./memory-chrome";

/** Every choice a review item offers. */
export type ReviewChoice =
  | "approve"
  | "dismiss"
  | "merge"
  | "distinct"
  | "keep-a"
  | "keep-b"
  | "both"
  | "accept"
  | "reject";

export interface MemoryReviewQueueViewProps {
  loaded: boolean;
  /** The queue could not be read; shown instead of claiming it is empty. */
  error: string | null;
  onRetry: () => void;
  /** In queue order, the front item first. */
  items: ReviewItem[];
  /** The choice in flight, so its buttons hold still. */
  pending: boolean;
  onChoose: (item: ReviewItem, choice: ReviewChoice) => void;
  onLater: (item: ReviewItem) => void;
  onBringForward: (item: ReviewItem) => void;
}

const TYPE_ICON: Record<ReviewItem["type"], LucideIcon> = {
  conflict: GitBranch,
  dream: Sparkles,
  merge: GitMerge,
  candidate: Inbox,
};

export function MemoryReviewQueueView(p: MemoryReviewQueueViewProps) {
  if (!p.loaded) {
    return (
      <div aria-busy aria-label="Loading the review queue" className="mx-auto max-w-2xl px-4 pt-8">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (p.items.length === 0) {
    return p.error ? (
      <Notice
        title="Couldn't read the review queue"
        action={
          <Button size="sm" variant="outline" onClick={p.onRetry}>
            Try again
          </Button>
        }
      >
        <span className="font-mono text-2xs break-words">{p.error}</span>
      </Notice>
    ) : (
      <EmptyState
        className="h-full"
        icon={CheckCircle2}
        title="Nothing to review"
        description="When an agent records something it isn't sure of, or two memories disagree, it waits here for you."
      />
    );
  }

  const [front, ...rest] = p.items;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 pt-6 pb-16">
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-md font-medium text-foreground tabular-nums">
            {p.items.length} waiting
          </h2>
          <span className="text-xs text-muted-foreground">Nothing changes until you choose.</span>
        </div>

        <article
          key={front.key}
          aria-label={REVIEW_EYEBROW[front.type]}
          className="session-row-in @container rounded-lg border border-border bg-card p-4"
        >
          <div className="mb-3 flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
            <TypeGlyph type={front.type} />
            {REVIEW_EYEBROW[front.type]}
          </div>
          <FrontBody item={front} />
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Choices item={front} pending={p.pending} onChoose={(c) => p.onChoose(front, c)} />
            <span className="ml-auto" />
            {rest.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={p.pending}
                onClick={() => p.onLater(front)}
              >
                Later
              </Button>
            )}
          </div>
        </article>

        {rest.length > 0 && (
          <section aria-label="Up next" className="mt-6">
            <h3 className="mb-1.5 flex items-center gap-2 text-2xs font-medium text-muted-foreground">
              Up next
              <span className="tabular-nums text-disabled">{rest.length}</span>
              <span aria-hidden className="h-px flex-1 bg-border-subtle" />
            </h3>
            <ul className="space-y-px">
              {rest.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    disabled={p.pending}
                    onClick={() => p.onBringForward(item)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition-colors duration-fast ease-out-strong hover:bg-element-hover disabled:cursor-default"
                  >
                    <TypeGlyph type={item.type} />
                    <span className="min-w-0 flex-1 truncate text-xs text-secondary-foreground">
                      {summary(item)}
                    </span>
                    <span className="shrink-0 text-2xs text-disabled">
                      {REVIEW_EYEBROW[item.type]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function TypeGlyph({ type }: { type: ReviewItem["type"] }) {
  const Icon = TYPE_ICON[type];
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

function summary(item: ReviewItem): string {
  switch (item.type) {
    case "conflict":
      return `${item.a.content} / ${item.b.content}`;
    case "dream":
      return dreamLabel(item.proposal.op);
    case "merge":
      return item.keep.content;
    case "candidate":
      return item.entry.content;
  }
}

function FrontBody({ item }: { item: ReviewItem }) {
  switch (item.type) {
    case "candidate":
      return <Memory entry={item.entry} large />;
    case "conflict":
      return (
        <div className="grid gap-2 @lg:grid-cols-2">
          <Side label="A" entry={item.a} />
          <Side label="B" entry={item.b} />
        </div>
      );
    case "merge":
      return (
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-2xs text-muted-foreground">Keep</p>
            <Memory entry={item.keep} />
          </div>
          <div className="space-y-2 border-l border-border pl-3">
            <p className="text-2xs text-muted-foreground">Folds in</p>
            {item.drop.map((d) => (
              <Memory key={d.id} entry={d} muted />
            ))}
          </div>
        </div>
      );
    case "dream":
      return (
        <div className="space-y-3">
          <p className="text-base leading-relaxed text-foreground">
            {dreamLabel(item.proposal.op)}
          </p>
          {item.proposal.why && (
            <p className="text-xs text-muted-foreground">{item.proposal.why}</p>
          )}
          {item.proposal.entries.length > 0 && (
            <div className="space-y-2 border-l border-border pl-3">
              {item.proposal.entries.map((e) => (
                <Memory key={e.id} entry={e} muted />
              ))}
            </div>
          )}
        </div>
      );
  }
}

function Side({ label, entry }: { label: string; entry: MemoryEntry }) {
  return (
    <div className="rounded-md border border-border-subtle bg-background p-3">
      <p className="mb-1 text-2xs font-medium text-muted-foreground">{label}</p>
      <Memory entry={entry} />
    </div>
  );
}

function Memory({
  entry: e,
  large,
  muted,
}: {
  entry: MemoryEntry;
  large?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "break-words",
          large ? "text-base leading-relaxed" : "text-sm leading-snug",
          muted ? "text-secondary-foreground" : "text-foreground",
        )}
      >
        {e.content}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
        <KindGlyph kind={e.kind} />
        <span>{kindNoun(e.kind)}</span>
        <span aria-hidden className="text-disabled">
          ·
        </span>
        <EntryAuthor entry={e} />
        <span aria-hidden className="text-disabled">
          ·
        </span>
        <span className="tabular-nums">{confidenceLabel(e.confidence)} sure</span>
      </p>
    </div>
  );
}

function Choices({
  item,
  pending,
  onChoose,
}: {
  item: ReviewItem;
  pending: boolean;
  onChoose: (c: ReviewChoice) => void;
}) {
  const btn = (choice: ReviewChoice, label: string, primary = false) => (
    <Button
      key={choice}
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={pending}
      onClick={() => onChoose(choice)}
    >
      {label}
    </Button>
  );
  switch (item.type) {
    case "candidate":
      return (
        <>
          {btn("approve", "Approve", true)}
          {btn("dismiss", "Dismiss")}
        </>
      );
    case "conflict":
      return (
        <>
          {btn("keep-a", "Keep A")}
          {btn("keep-b", "Keep B")}
          {btn("both", "Both hold")}
        </>
      );
    case "merge":
      return (
        <>
          {btn("merge", "Merge", true)}
          {btn("distinct", "Not the same")}
        </>
      );
    case "dream":
      return (
        <>
          {btn("accept", "Accept", true)}
          {btn("reject", "Dismiss")}
        </>
      );
  }
}
