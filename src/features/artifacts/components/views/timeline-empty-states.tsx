/**
 * The first thing a new user sees.
 *
 * Not an error, and not three alarms — capture being off is the default state of
 * every Project, and the only useful thing to say about it is what turning it
 * on would give you.
 */
export function NotEnabled() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h2 className="text-md font-medium text-[var(--foreground)]">Nothing captured yet</h2>
      <p className="mt-1.5 max-w-[420px] text-sm leading-relaxed text-[var(--muted-foreground)]">
        Turn capture on for a project and Atlas records what you asked, what the agent did, and
        which commits came out of it — stored on this machine, with secrets scrubbed before anything
        is written.
      </p>
      {/* The control is deliberately not repeated here. Capture is per project
       *  and this board spans all of them, so the honest place to switch it on
       *  is the project pill in the titlebar, which names the one it applies to. */}
      <p className="mt-3 max-w-[420px] text-xs text-[var(--atlas-text-disabled)]">
        Click the project name in the titlebar to turn it on.
      </p>
    </div>
  );
}

/** The store answered: this Session does not exist (deleted, or another
 *  Project's id). Distinct from loading — a spinner here never resolves. */
/**
 * The open Session could not be read.
 *
 * `reason` separates "the row is gone" from "the read failed", which are not
 * the same thing and used to look identical: a Session held on the server that
 * this Organisation cannot reach was reported as deleted.
 */
export function NotFound({ reason, onBack }: { reason: string | null; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <p className="text-base text-[var(--secondary-foreground)]">
        {reason ?? "This session no longer exists."}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 cursor-pointer rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
      >
        Back to sessions
      </button>
    </div>
  );
}
