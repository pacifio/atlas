/** The "agent process exited" banner above the composer, with its one
 *  Restart affordance. `agentLabel` names the agent in the "updated" copy. */
export function DisconnectedBannerView({
  bindError,
  updatedTo,
  agentLabel,
  restarting,
  onRestart,
}: {
  bindError: string | undefined;
  updatedTo: string | undefined;
  agentLabel: string;
  restarting: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm">
      <span className="select-text text-[var(--secondary-foreground)]">
        {bindError
          ? `The agent exited while starting (${bindError.slice(0, 160)}). Your message is back in the queue — restart to try again.`
          : updatedTo
            ? `${agentLabel} was updated to v${updatedTo}. Your conversation is safe — your next message continues it on the new version.`
            : "The agent process exited. Your conversation is safe — restart to continue where you left off."}
      </span>
      <button
        disabled={restarting}
        onClick={onRestart}
        className="shrink-0 px-2.5 h-6 rounded-md bg-[var(--foreground)] text-[var(--background)] text-xs font-medium hover:bg-[var(--secondary-foreground)] disabled:opacity-50 cursor-pointer"
      >
        {restarting ? "Restarting…" : "Restart agent"}
      </button>
    </div>
  );
}
