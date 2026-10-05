import { useState } from "react";
import { GitPullRequestArrow, TriangleAlert } from "lucide-react";

import { Button } from "@/ui/button";

import {
  applyThread,
  sharedThreadError,
  type ApplyOutcome,
  type SharedThreadError,
} from "../lib/shared-threads-api";

/** "3 files", "1 file". */
function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** Scroll the thread's open Conflicts into view. */
function showConflicts() {
  document.querySelector('[aria-label="Conflicts"]')?.scrollIntoView({ block: "nearest" });
}

/**
 * Apply (ATL-408): the way work leaves a Shared Thread. The thread's changes
 * since its Base are written into the person's own checkout as uncommitted
 * changes; they commit and push their usual way. Any participant may Apply,
 * any number of times; it never closes the thread.
 */
export function ApplyPanel({
  sharedThreadId,
  hasCheckout,
  openConflicts,
}: {
  sharedThreadId: string;
  /** Joined from a checkout of the project — Apply's destination. */
  hasCheckout: boolean;
  openConflicts: number;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [error, setError] = useState<SharedThreadError | null>(null);

  async function run(stash: boolean) {
    setBusy(true);
    setError(null);
    try {
      setOutcome(await applyThread(sharedThreadId, stash));
    } catch (e) {
      setError(sharedThreadError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!hasCheckout) {
    return (
      <p className="text-[var(--muted-foreground)]">
        Apply writes the thread&apos;s changes into your own checkout — join from one to use it.
      </p>
    );
  }

  return (
    <section aria-label="Apply" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || openConflicts > 0}
          onClick={() => void run(false)}
        >
          <GitPullRequestArrow size={11} />
          {busy ? "Applying…" : "Apply to my checkout"}
        </Button>
        {openConflicts > 0 && (
          <button
            type="button"
            className="text-warning underline-offset-2 hover:underline"
            onClick={showConflicts}
          >
            Resolve {openConflicts === 1 ? "the open Conflict" : `${openConflicts} open Conflicts`} first
          </button>
        )}
      </div>
      {outcome && <Outcome outcome={outcome} busy={busy} onStash={() => void run(true)} />}
      {error && <p className="text-error">{error.message}</p>}
    </section>
  );
}

function Outcome({
  outcome,
  busy,
  onStash,
}: {
  outcome: ApplyOutcome;
  busy: boolean;
  onStash: () => void;
}) {
  if (outcome.outcome === "conflictsOpen") {
    return (
      <p className="text-warning">
        {outcome.count === 1 ? "A Conflict is" : `${outcome.count} Conflicts are`} open in this
        thread. Resolve them, then Apply.
      </p>
    );
  }
  if (outcome.outcome === "dirty") {
    return (
      <div className="flex flex-col gap-1 rounded bg-warning-muted p-2">
        <span className="flex items-center gap-1.5 font-medium text-warning">
          <TriangleAlert size={12} /> You have uncommitted changes to {files(outcome.files.length)}{" "}
          this thread changed
        </span>
        {outcome.files.map((path) => (
          <span key={path} className="font-mono text-[var(--foreground)]">
            {path}
          </span>
        ))}
        <span className="text-[var(--secondary-foreground)]">
          Nothing was written. Commit them, or stash just these files and apply — <span className="font-mono">git stash pop</span> brings your edits back.
        </span>
        <Button size="xs" variant="outline" className="self-start" disabled={busy} onClick={onStash}>
          Stash and apply
        </Button>
      </div>
    );
  }
  const clean = outcome.files.length;
  return (
    <div className="flex flex-col gap-1 rounded bg-[var(--atlas-element-hover)] p-2 text-[var(--secondary-foreground)]">
      <span className="text-[var(--foreground)]">
        {clean + outcome.conflicted.length === 0
          ? "Your checkout already has everything in this thread."
          : `Applied ${files(clean)} as uncommitted changes. Review, commit and push as usual.`}
      </span>
      {outcome.conflicted.length > 0 && (
        <>
          <span className="font-medium text-warning">
            {files(outcome.conflicted.length)} also changed in your commits — look for conflict markers:
          </span>
          {outcome.conflicted.map((path) => (
            <span key={path} className="font-mono text-[var(--foreground)]">
              {path}
            </span>
          ))}
        </>
      )}
      {outcome.beside.length > 0 && (
        <span>
          Binary files kept your version; the thread&apos;s is beside it as{" "}
          <span className="font-mono">{outcome.beside.join(", ")}</span>.
        </span>
      )}
      {outcome.setAside.length > 0 && (
        <span>
          Your own copies of ignored files were in the way. They are kept inside your
          repository&apos;s .git folder, where nothing gets committed:{" "}
          <span className="break-all font-mono">{outcome.setAside.join(", ")}</span>
        </span>
      )}
      {outcome.stashed && (
        <span>
          Your edits to those files are stashed as &ldquo;{outcome.stashed}&rdquo; —{" "}
          <span className="font-mono">git stash pop</span> brings them back.
        </span>
      )}
    </div>
  );
}
