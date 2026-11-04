import { createElement, type ReactElement } from "react";
import { AlertTriangle, Bot, Check, Hand, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentGlyph } from "@/features/artifacts/components/agent-glyph";
import { catalogEntry, type NotificationKind } from "../lib/catalog";
import { leadingBadge, type LeadingBadge } from "../lib/leading-badge";
import { sourceIconFor, type SourceIconTone } from "../lib/source-icon";

const BADGE_STYLE: Record<LeadingBadge, { bg: string; Icon: typeof Check }> = {
  done: { bg: "bg-success", Icon: Check },
  failed: { bg: "bg-error", Icon: X },
  "needs-you": { bg: "bg-primary", Icon: Hand },
  warning: { bg: "bg-warning", Icon: AlertTriangle },
};

const TONE_CLASS: Record<SourceIconTone, string> = {
  primary: "text-primary",
  muted: "text-secondary-foreground",
  warning: "text-warning",
  error: "text-error",
};

/** Source icon for kinds that do not come from an agent. */
function SourceIcon({ kind, size }: { kind: NotificationKind; size: number }) {
  const { icon: Glyph, tone } = sourceIconFor(kind);
  return <Glyph size={size} strokeWidth={1.5} className={TONE_CLASS[tone]} />;
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
            "ring-2 ring-card text-card",
            b.bg,
          )}
        >
          <b.Icon size={6} strokeWidth={3} aria-hidden />
        </span>
      )}
    </span>
  );
}

/** The icon as a toast's `icon` (deliver.ts is plain TS). */
export function notificationToastIcon(kind: NotificationKind, agentType?: string): ReactElement {
  return createElement(NotificationLeadingIcon, { kind, agentType });
}
