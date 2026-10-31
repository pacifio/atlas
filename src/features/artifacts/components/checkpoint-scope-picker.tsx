/**
 * What the Session chat is allowed to read.
 *
 * Grounding on the whole Session is expensive and, more often than not, blunt:
 * the question people arrive with is "what did this commit change", and four
 * hours of unrelated turns is noise the model has to be told to ignore. So the
 * reader narrows the record to one or more Checkpoints.
 *
 * Selecting a Checkpoint takes its SPAN — the work that produced the commit —
 * not just the commit row; see `scope_to_checkpoints` in `session_chat.rs`.
 *
 * A Session with no Checkpoints still gets the strip, but as a STATEMENT rather
 * than a control: "Full timeline · no checkpoints", with no chevron and no
 * clear button. There is nothing to choose, and a dropdown that opens onto one
 * disabled option is worse than plain text — but silently dropping the header
 * left the composer looking like it had lost a row.
 */

import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, GitCommitHorizontal, Layers, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import type { TimelineEntry } from "../types";

/**
 * The tucked header itself, same construction as Memory ▸ Chat's codebase strip
 * (the former memory-chat view): inset by `mx-2` so the composer's box is wider,
 * `rounded-t-xl` for the curve, and `-mb-3.5` against `pb-5` so the box overlaps
 * its lower half. `z-0` keeps it behind — the composer carries `relative z-10`.
 */
const STRIP =
  "relative z-0 mx-2 -mb-3.5 flex items-center justify-between gap-3 rounded-t-xl " +
  "bg-[var(--popover)] px-3.5 pt-1.5 pb-5 text-xs";

/** Checkpoints of one Session, newest first. */
function sessionCheckpoints(entries: TimelineEntry[]): TimelineEntry[] {
  return entries
    .filter((e) => e.kind === "checkpoint" && !!e.commitSha)
    .slice()
    .reverse();
}

/**
 * The scope a NEW thread starts with: the latest Checkpoint when the Session has
 * any, otherwise the whole timeline. Applied once at thread creation rather than
 * on every render — re-deriving it per send would quietly overrule someone who
 * deliberately chose "Full timeline".
 */
export function defaultScope(entries: TimelineEntry[]): string[] | null {
  const latest = sessionCheckpoints(entries)[0];
  return latest?.commitSha ? [latest.commitSha] : null;
}

export function CheckpointScopePicker({
  entries,
  scope,
  onChange,
}: {
  entries: TimelineEntry[];
  /** `null` = the whole Session. */
  scope: string[] | null;
  onChange: (scope: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const checkpoints = useMemo(() => sessionCheckpoints(entries), [entries]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return checkpoints;
    // Subject, sha and branch — the three things someone actually remembers
    // about a commit they are looking for.
    return checkpoints.filter((c) =>
      [c.commitSubject, c.commitSha, c.branch]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    );
  }, [checkpoints, query]);

  const selected = new Set(scope ?? []);
  const isFull = !scope || scope.length === 0;
  // Lead + supporting detail, mirroring the codebase strip: the bold part is
  // what is being read, the muted part is how much of the Session that is.
  const label = isFull ? "Full timeline" : `${selected.size} of ${checkpoints.length} checkpoints`;
  const detailText = isFull
    ? ` · ${checkpoints.length} checkpoints available`
    : selected.size === 1
      ? ` · ${firstSelectedSubject(checkpoints, selected)}`
      : " · scoped";

  const toggle = (sha: string) => {
    const next = new Set(selected);
    if (next.has(sha)) next.delete(sha);
    else next.add(sha);
    // Deselecting the last one means "everything", not "nothing" — a chat
    // grounded on no record at all is never what someone wanted.
    onChange(next.size === 0 ? null : [...next]);
  };

  // Nothing to pick: same strip, no affordances.
  if (checkpoints.length === 0) {
    return (
      <div className={STRIP}>
        <span className="flex min-w-0 items-center gap-2 truncate">
          <Layers size={12} className="shrink-0 text-[var(--muted-foreground)]" />
          <span className="truncate">
            <span className="font-semibold text-[var(--foreground)]">Full timeline</span>
            <span className="text-[var(--muted-foreground)]"> · no checkpoints</span>
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className={STRIP}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              title="Choose what this session reads"
              className="flex min-w-0 items-center gap-2 truncate text-left cursor-pointer outline-none"
            >
              {isFull ? (
                <Layers size={12} className="shrink-0 text-[var(--muted-foreground)]" />
              ) : (
                <GitCommitHorizontal
                  size={12}
                  className="shrink-0 text-[var(--muted-foreground)]"
                />
              )}
              <span className="truncate">
                <span className="font-semibold text-[var(--foreground)]">{label}</span>
                {detailText && <span className="text-[var(--muted-foreground)]">{detailText}</span>}
              </span>
              <ChevronDown
                size={11}
                className={cn(
                  "shrink-0 text-[var(--muted-foreground)] transition-transform",
                  open && "rotate-180",
                )}
              />
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner className="z-popover" align="start" side="top" sideOffset={8}>
            <Popover.Popup
              className={cn(
                "flex max-h-[380px] w-[340px] flex-col overflow-hidden rounded-xl select-none",
                // Border, fill, blur and animation on ONE element — splitting them
                // isolates the layer and flattens the backdrop blur.
                "border border-border bg-[var(--card)]/95 backdrop-blur-2xl",
                "inset-highlight shadow-md",
                "origin-[var(--transform-origin)] data-open:animate-scale-in",
              )}
            >
              {/* Search first, like the agent chat's session picker. A Session can
                  carry dozens of Checkpoints and the one you want is remembered by
                  its subject, not its position. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
                <Search size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  aria-label="Search checkpoints"
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
                {shown.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
                    No checkpoint matches.
                  </p>
                ) : (
                  shown.map((c) => (
                    <Row
                      key={c.commitSha ?? c.id}
                      icon={<GitCommitHorizontal size={12} />}
                      title={c.commitSubject || "(no subject)"}
                      meta={[c.commitSha?.slice(0, 7), c.branch].filter(Boolean).join(" · ")}
                      added={c.insertions}
                      removed={c.deletions}
                      checked={selected.has(c.commitSha ?? "")}
                      onClick={() => c.commitSha && toggle(c.commitSha)}
                    />
                  ))
                )}
              </div>

              {/* Full timeline lives at the FOOTER: it is the escape hatch, not
                  the expected choice. Putting it first made the costly option the
                  one the eye lands on. */}
              <button
                type="button"
                onClick={() => onChange(null)}
                className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-3 py-2 text-left transition-colors hover:bg-element-hover cursor-pointer"
              >
                <Layers size={12} className="shrink-0 text-[var(--muted-foreground)]" />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
                  Full timeline
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
                  {checkpoints.length} checkpoints
                </span>
                {isFull && <Check size={12} className="shrink-0 text-[var(--foreground)]" />}
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <Hint label="Read the whole session">
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={isFull}
          className={cn(
            "shrink-0 rounded p-0.5 transition-colors",
            isFull
              ? "cursor-default text-[var(--muted-foreground)]/30"
              : "cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
          )}
        >
          <X size={12} />
        </button>
      </Hint>
    </div>
  );
}

/** Subject of the single selected Checkpoint, for the strip's muted detail. */
function firstSelectedSubject(checkpoints: TimelineEntry[], selected: Set<string>): string {
  const hit = checkpoints.find((c) => c.commitSha && selected.has(c.commitSha));
  return hit?.commitSubject || hit?.commitSha?.slice(0, 7) || "1 checkpoint";
}

function Row({
  icon,
  title,
  meta,
  added,
  removed,
  checked,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
  added: number;
  removed: number;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2 border-b border-border-subtle px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-element-hover cursor-pointer"
    >
      <span className="mt-px shrink-0 text-[var(--muted-foreground)]">{icon}</span>
      <span className="min-w-0 flex-1">
        {/* Subject on its own line: it is what gets scanned. The sha, branch and
            diffstat are supporting detail and belong under it. */}
        <span className="block truncate text-xs text-[var(--foreground)]">{title}</span>
        <span className="flex items-center gap-1.5 font-mono text-2xs text-[var(--muted-foreground)]">
          <span className="min-w-0 truncate">{meta}</span>
          {added > 0 && <span className="text-[var(--atlas-diff-added-text)]">+{added}</span>}
          {removed > 0 && (
            <span className="text-[var(--atlas-status-error-foreground)]">−{removed}</span>
          )}
        </span>
      </span>
      {checked && <Check size={12} className="mt-px shrink-0 text-[var(--foreground)]" />}
    </button>
  );
}
