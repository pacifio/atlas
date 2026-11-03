import type { CloudOrg, RunAction } from "../lib/capture-flow";
import type { Binding, ConnectPick } from "../types";
import { ConnectTab } from "./connect-tab";

/**
 * Cloud→Cloud step one: which other Project this one should sync to.
 *
 * The Connect picker in its no-mutation mode, minus the Project already synced
 * to. Nothing here changes anything — the disclosure step owns the move.
 */
export function SwitchForm({
  projectPath,
  binding,
  cloudOrgs,
  cloudReason,
  busy,
  run,
  onCancel,
  onContinue,
}: {
  projectPath: string;
  binding: Binding;
  cloudOrgs: CloudOrg[];
  cloudReason: string | null;
  busy: boolean;
  run: RunAction;
  onCancel: () => void;
  onContinue: (pick: ConnectPick) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-[var(--foreground)]">Change Project</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        Currently syncing to{" "}
        <span className="font-mono text-[var(--secondary-foreground)]">{binding.slug ?? "—"}</span>.
        Everything captured here will be re-sent to the Project you pick.
      </p>
      <ConnectTab
        projectPath={projectPath}
        cloudOrgs={cloudOrgs}
        cloudReason={cloudReason}
        busy={busy}
        run={run}
        onCancel={onCancel}
        onContinue={onContinue}
        excludeId={binding.remoteWorkspaceId}
      />
    </div>
  );
}
