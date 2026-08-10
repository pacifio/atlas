/**
 * The three marks that describe a project's working tree.
 *
 * They belong together and belong here: the workspace sidebar and the Timeline's
 * project picker both answer the same question — *which* of these projects is
 * the one I was working in — and a bare list of names cannot, once two of them
 * are called `api` and `api-v2`. The dot, the branch and the +N/−M are what tell
 * them apart, so both surfaces show all three.
 *
 * Extracted after the second copy appeared. The copies had already drifted:
 * one used `--accent-positive` with a hex fallback the token never defined,
 * the other the real `--stat-added`, which happen to be the same green — so the
 * drift was invisible until a theme remapped one of them.
 */

import { GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";

import type { GitSummary } from "../stores/workspace-git-store";

/** Working-tree state at a glance: green clean, amber dirty, grey non-repo. */
export function GitDot({ summary, className }: { summary?: GitSummary; className?: string }) {
  const color =
    !summary || !summary.isRepo
      ? "var(--text-tertiary)"
      : summary.dirty
        ? "var(--status-warning)"
        : "var(--capture-live)";
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: color }}
      title={
        !summary?.isRepo
          ? "Not a git repository"
          : summary.dirty
            ? "Working tree dirty"
            : "Working tree clean"
      }
    />
  );
}

/** `branch  subject`, or a note that there is no repository to describe. */
export function BranchLine({ summary, className }: { summary?: GitSummary; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-[10px] leading-tight text-[var(--text-tertiary)]",
        className,
      )}
    >
      {summary?.isRepo && <GitBranch size={9} className="shrink-0" />}
      <span className="truncate font-mono">
        {summary?.isRepo
          ? `${summary.branch || "—"}${summary.headSubject ? `  ${summary.headSubject}` : ""}`
          : "no source control"}
      </span>
    </span>
  );
}

/** +N/−M for an uncommitted working tree. Renders nothing when clean. */
export function NumStatPill({ summary }: { summary?: GitSummary }) {
  if (!summary || (summary.additions === 0 && summary.deletions === 0)) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-elevated)] px-1.5 py-[1px] font-mono text-[9px]">
      {summary.additions > 0 && (
        <span className="text-[var(--stat-added)]">+{summary.additions}</span>
      )}
      {summary.deletions > 0 && (
        <span className="text-[var(--stat-removed)]">−{summary.deletions}</span>
      )}
    </span>
  );
}
