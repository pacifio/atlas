import { Check, Download, Loader2, LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClaudeSetupStore } from "../stores/claude-setup-store";

/**
 * Status pill that sits centered above the message composer. Returns
 * `null` when Claude Code is installed + authed (phase = `ready`), so
 * the composer occupies its normal layout slot with no extra chrome.
 *
 * One pill per state — clicking it advances the flow (Install →
 * Sign in → ready). Matches the visual idiom of the "Scroll to bottom"
 * floater so it reads as the primary action.
 */
export function ClaudeSetupBanner() {
  const phase = useClaudeSetupStore.use.phase();
  const installError = useClaudeSetupStore.use.installError();
  const { install, openLoginDialog, refreshStatus } = useClaudeSetupStore.use.actions();

  if (phase === "ready") return null;

  let content: React.ReactNode;
  switch (phase) {
    case "checking":
      content = (
        <StatusPill>
          <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
          <span>Checking Claude Code…</span>
        </StatusPill>
      );
      break;

    case "not-installed":
      content = (
        <ActionPill onClick={() => void install()}>
          <Download size={12} />
          <span>Install Claude Code</span>
        </ActionPill>
      );
      break;

    case "installing":
      content = (
        <StatusPill>
          <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
          <span>Installing Claude Code…</span>
        </StatusPill>
      );
      break;

    case "install-success":
      content = (
        <StatusPill variant="success">
          <Check size={11} />
          <span>Claude Code installed</span>
        </StatusPill>
      );
      break;

    case "install-failed":
      content = (
        <ActionPill onClick={() => void install()} variant="error">
          <TriangleAlert size={11} />
          <span>{installError ?? "Install failed"} — Retry</span>
          <RefreshCw size={11} className="ml-1 opacity-70" />
        </ActionPill>
      );
      break;

    case "not-authed":
      content = (
        <ActionPill onClick={openLoginDialog}>
          <LogIn size={12} />
          <span>Sign in to Claude Code</span>
        </ActionPill>
      );
      break;

    case "authing":
      content = (
        <ActionPill onClick={() => void refreshStatus()} variant="muted">
          <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
          <span>Waiting for sign-in…</span>
          <RefreshCw size={11} className="ml-1 opacity-70" />
        </ActionPill>
      );
      break;

    default:
      content = null;
  }

  // The parent (ChatComposer's floating row) handles positioning and
  // centering — we just return the pill itself.
  return <>{content}</>;
}

// ── pill primitives ────────────────────────────────────────────────────────

/** Read-only status indicator (no action). */
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

/** Clickable action — same pill silhouette as StatusPill, with hover. */
function ActionPill({
  children,
  onClick,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "muted" | "error";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
        "border text-[11px] leading-none font-medium cursor-pointer transition-colors",
        "shadow-[0_2px_8px_rgba(0,0,0,0.35)] backdrop-blur-sm",
        variant === "error"
          ? "border-[var(--status-error)]/40 bg-[var(--status-error)]/15 text-[var(--status-error)] hover:bg-[var(--status-error)]/25"
          : variant === "muted"
            ? "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      {children}
    </button>
  );
}
