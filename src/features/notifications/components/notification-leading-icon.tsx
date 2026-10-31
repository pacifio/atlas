import { createElement, type ReactElement } from "react";
import {
  AlertTriangle,
  BellRing,
  Bot,
  Check,
  Download,
  GitBranch,
  GitPullRequest,
  Hand,
  KeyRound,
  MessageSquare,
  ShieldAlert,
  SquareTerminal,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentGlyph } from "@/features/artifacts/components/agent-glyph";
import { catalogEntry, type NotificationKind } from "../lib/catalog";
import { leadingBadge, type LeadingBadge } from "../lib/leading-badge";

const BADGE_STYLE: Record<LeadingBadge, { bg: string; Icon: typeof Check }> = {
  done: { bg: "bg-[var(--atlas-status-success-foreground)]", Icon: Check },
  failed: { bg: "bg-[var(--atlas-status-error-foreground)]", Icon: X },
  "needs-you": { bg: "bg-[var(--primary)]", Icon: Hand },
  warning: { bg: "bg-[var(--atlas-status-warning-foreground)]", Icon: AlertTriangle },
};

/** Source icon for kinds that do not come from an agent. */
function SourceIcon({ kind, size }: { kind: NotificationKind; size: number }) {
  const common = { size, strokeWidth: 1.5 };
  const error = "text-[var(--atlas-status-error-foreground)]";
  if (kind === "atlas-signed-out") return <KeyRound {...common} className="text-primary" />;
  if (kind === "app-update-ready") return <Download {...common} className="text-primary" />;
  if (kind === "model-download-done")
    return <Download {...common} className="text-secondary-foreground" />;
  if (kind === "model-download-failed") return <Download {...common} className={error} />;
  if (kind === "git-op-done")
    return <GitBranch {...common} className="text-secondary-foreground" />;
  if (kind === "git-op-failed") return <GitBranch {...common} className={error} />;
  const warn = "text-[var(--atlas-status-warning-foreground)]";
  if (kind === "git-autofetch-failing" || kind === "git-behind")
    return <GitBranch {...common} className={warn} />;
  if (kind === "config-error") return <AlertTriangle {...common} className={warn} />;
  if (kind === "agent-update-failed") return <Download {...common} className={warn} />;
  if (kind === "security-finding") return <ShieldAlert {...common} className={error} />;
  if (kind === "pull-request-guide")
    return <GitPullRequest {...common} className="text-secondary-foreground" />;
  const source = catalogEntry(kind).source;
  if (source === "chat") return <MessageSquare {...common} className="text-primary" />;
  if (kind === "terminal-failed")
    return <AlertTriangle {...common} className="text-[var(--atlas-status-error-foreground)]" />;
  if (kind === "terminal-attention")
    return <BellRing {...common} className="text-[var(--atlas-status-warning-foreground)]" />;
  if (source === "terminal")
    return <SquareTerminal {...common} className="text-secondary-foreground" />;
  return <Sparkles {...common} className="text-secondary-foreground" />;
}

/**
 * The leading icon of a notification (toast and center): the originating
 * agent's mark with a status badge for agent kinds, a source icon otherwise.
 * The mark resolves through `AgentGlyph` (registry-aware, so externally
 * installed agents bring their own icon); no agentType degrades to a neutral glyph.
 */
export function NotificationLeadingIcon({
  kind,
  agentType,
  size = 16,
}: {
  kind: NotificationKind;
  agentType?: string;
  size?: number;
}) {
  if (catalogEntry(kind).source !== "agent" && !agentType) {
    return <SourceIcon kind={kind} size={size} />;
  }
  const badge = leadingBadge(kind);
  const b = badge ? BADGE_STYLE[badge] : null;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      {agentType ? (
        <AgentGlyph agent={agentType} size={size} />
      ) : (
        <Bot size={size} strokeWidth={1.5} className="text-secondary-foreground" />
      )}
      {b && (
        <span
          data-badge={badge}
          className={cn(
            "absolute -bottom-1 -right-1 grid size-2.5 place-items-center rounded-full",
            "ring-2 ring-[var(--card)] text-[var(--card)]",
            b.bg,
          )}
        >
          <b.Icon size={6} strokeWidth={3} aria-hidden />
        </span>
      )}
    </span>
  );
}

/** The icon as a sonner toast's `icon` (deliver.ts is plain TS). */
export function notificationToastIcon(kind: NotificationKind, agentType?: string): ReactElement {
  return createElement(NotificationLeadingIcon, { kind, agentType });
}
