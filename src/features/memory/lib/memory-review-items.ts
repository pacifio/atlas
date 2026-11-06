// Pure shaping for the Review tab: the backend's four lists read as one
// queue, in the order a person should meet them. A contradiction first (two
// agents are being told opposite things right now), then the nightly
// review's proposals, then duplicates, then lines nobody confirmed yet.

import type { DreamProposal, MemoryEntry, MergeProposal, ReviewQueue } from "./shared-memory-api";

export type ReviewItem =
  | { type: "conflict"; key: string; a: MemoryEntry; b: MemoryEntry }
  | { type: "dream"; key: string; proposal: DreamProposal }
  | { type: "merge"; key: string; keep: MemoryEntry; drop: MemoryEntry[] }
  | { type: "candidate"; key: string; entry: MemoryEntry };

export function reviewItems(q: ReviewQueue): ReviewItem[] {
  return [
    ...q.conflicts.map(({ a, b }): ReviewItem => ({
      type: "conflict",
      key: `conflict:${a.id}:${b.id}`,
      a,
      b,
    })),
    ...(q.dreams ?? []).map((proposal): ReviewItem => ({
      type: "dream",
      key: `dream:${proposal.id}`,
      proposal,
    })),
    ...q.merges.map(({ keep, drop }: MergeProposal): ReviewItem => ({
      type: "merge",
      key: `merge:${keep.id}`,
      keep,
      drop,
    })),
    ...q.candidates.map((entry): ReviewItem => ({
      type: "candidate",
      key: `candidate:${entry.id}`,
      entry,
    })),
  ];
}

export function reviewCount(q: ReviewQueue): number {
  return q.conflicts.length + (q.dreams?.length ?? 0) + q.merges.length + q.candidates.length;
}

/** The queue with skipped items moved to the end, in the order skipped. */
export function orderQueue(items: ReviewItem[], skipped: readonly string[]): ReviewItem[] {
  const later = new Set(skipped);
  const now = items.filter((i) => !later.has(i.key));
  const deferred = skipped
    .map((k) => items.find((i) => i.key === k))
    .filter((i): i is ReviewItem => i !== undefined);
  return [...now, ...deferred];
}

/** What kind of decision an item asks for, as its eyebrow. */
export const REVIEW_EYEBROW: Record<ReviewItem["type"], string> = {
  conflict: "These disagree",
  dream: "Proposed by the nightly review",
  merge: "Looks like the same memory",
  candidate: "Not confirmed yet",
};

/** One line saying what a nightly-review proposal would do. */
export function dreamLabel(op: DreamProposal["op"]): string {
  switch (op.op) {
    case "add":
      return `Add ${op.kind ?? "memory"}: ${op.content ?? ""}`;
    case "merge":
      return "Merge these into the first";
    case "archive":
      return `Archive (${op.reason ?? "unused"})`;
    case "rewrite":
      return `Rewrite as: ${op.content ?? ""}`;
    case "link":
      return op.rel === "supersedes" ? "The first replaces the second" : "These contradict";
    default:
      return op.op;
  }
}
