/**
 * The leading icon for a notification that does not come from an agent: which
 * glyph, and which tone it takes. Pure, so the ladder is testable without
 * rendering.
 */
import {
  AlertTriangle,
  BellRing,
  Download,
  GitBranch,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { catalogEntry, type NotificationKind } from "./catalog";

export type SourceIconTone = "primary" | "muted" | "warning" | "error";

export interface SourceIcon {
  icon: LucideIcon;
  tone: SourceIconTone;
}

/** Specific kinds first, then the source's default, then a neutral sparkle. */
export function sourceIconFor(kind: NotificationKind): SourceIcon {
  switch (kind) {
    case "atlas-signed-out":
      return { icon: KeyRound, tone: "primary" };
    case "app-update-ready":
      return { icon: Download, tone: "primary" };
    case "model-download-done":
      return { icon: Download, tone: "muted" };
    case "model-download-failed":
      return { icon: Download, tone: "error" };
    case "git-op-done":
      return { icon: GitBranch, tone: "muted" };
    case "git-op-failed":
      return { icon: GitBranch, tone: "error" };
    case "git-autofetch-failing":
    case "git-behind":
      return { icon: GitBranch, tone: "warning" };
    case "config-error":
      return { icon: AlertTriangle, tone: "warning" };
    case "agent-update-failed":
      return { icon: Download, tone: "warning" };
    case "security-finding":
      return { icon: ShieldAlert, tone: "error" };
    case "pull-request-guide":
      return { icon: GitPullRequest, tone: "muted" };
  }
  const source = catalogEntry(kind).source;
  if (source === "chat") return { icon: MessageSquare, tone: "primary" };
  if (kind === "terminal-failed") return { icon: AlertTriangle, tone: "error" };
  if (kind === "terminal-attention") return { icon: BellRing, tone: "warning" };
  if (source === "terminal") return { icon: SquareTerminal, tone: "muted" };
  return { icon: Sparkles, tone: "muted" };
}
