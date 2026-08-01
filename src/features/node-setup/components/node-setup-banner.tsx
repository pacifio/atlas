import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNodeSetupStore } from "../stores/node-setup-store";

/**
 * Status pill above the message composer for the bundled-nvm Node install.
 * Returns `null` unless an install is in flight / just finished / failed —
 * a compatible Node (phase `ok`/`idle`/`checking`) shows nothing, leaving the
 * Claude/Codex setup banner to own the row. Non-blocking: it only informs;
 * the app stays usable while Node downloads in the background.
 */
export function NodeSetupBanner() {
  const phase = useNodeSetupStore.use.phase();
  const reason = useNodeSetupStore.use.reason();
  const foundVersion = useNodeSetupStore.use.foundVersion();
  const minMajor = useNodeSetupStore.use.minMajor();
  const installError = useNodeSetupStore.use.installError();
  const { install } = useNodeSetupStore.use.actions();

  if (phase !== "installing" && phase !== "installed" && phase !== "failed") {
    return null;
  }

  if (phase === "installed") {
    return (
      <StatusPill variant="success">
        <Check size={11} />
        <span>Node ready</span>
      </StatusPill>
    );
  }

  if (phase === "failed") {
    return (
      <button
        onClick={() => void install()}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
          "border text-[11px] leading-none font-medium cursor-pointer transition-colors",
          "shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur-sm",
          "border-[var(--status-error)]/40 bg-[var(--status-error)]/15 text-[var(--status-error)] hover:bg-[var(--status-error)]/25",
        )}
        title={installError ?? undefined}
      >
        <TriangleAlert size={11} />
        <span>Node install failed — Retry</span>
        <RefreshCw size={11} className="ml-1 opacity-70" />
      </button>
    );
  }

  // installing
  const label =
    reason === "incompatible"
      ? `Updating Node (found ${foundVersion ?? "an old version"}, need ≥ ${minMajor})…`
      : "Installing Node…";
  return (
    <StatusPill>
      <Loader2
        size={11}
        className="animate-spin text-[var(--accent-primary)]"
      />
      <span>{label}</span>
    </StatusPill>
  );
}

function StatusPill({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "success";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
        "border text-[11px] leading-none font-medium",
        "shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur-sm",
        variant === "success"
          ? "border-[var(--status-success)]/40 bg-[var(--status-success)]/15 text-[var(--status-success)]"
          : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]",
      )}
    >
      {children}
    </div>
  );
}
