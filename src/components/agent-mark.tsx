import { cn } from "@/lib/utils";
import type { AgentType } from "@/types/agent";
import { AgentIcons, AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { agentMeta } from "@/features/agents/lib/agent-meta";

/**
 * Small per-agent identity badge. Reuses the `.amark` + `.agent-*` token
 * system (tokens.css) and renders the agent's brand icon (agent-icons.tsx) —
 * this is how parallel Claude / Codex chat sessions are told apart by icon.
 * External (registry-installed) agents render their manifest SVG, falling
 * back to a monogram of their label.
 */
function AgentGlyph({ agentType, size }: { agentType: AgentType; size: "sm" | "lg" }) {
  const cls = size === "lg" ? "size-[18px]" : "size-3.5";
  if (agentType === "claude-acp") return <AgentIcons.Claude className={cls} />;
  if (agentType === "codex-acp") return <AgentIcons.Codex className={cls} />;
  if (agentType === "opencode") return <AgentIcons.OpenCode className={cls} />;
  if (agentType === "cursor") return <AgentIcons.Cursor className={cls} />;
  if (agentType === "kilo") return <AgentIcons.Kilo className={cls} />;
  // Atlas's native agent — its own brand mark.
  if (agentType === "cersei") return <AtlasIcon size={size === "lg" ? 18 : 14} />;
  const meta = agentMeta(agentType);
  const px = size === "lg" ? 18 : 14;
  if (meta.firstPartyIcon) return <AgentGlyph agentType={meta.firstPartyIcon} size={size} />;
  if (meta.iconDataUrl) return <ExternalAgentIcon dataUrl={meta.iconDataUrl} size={px} />;
  return <AgentMonogram label={meta.label} size={px} />;
}

export function AgentMark({
  agentType,
  size = "sm",
  className,
}: {
  agentType: AgentType;
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <span
      className={cn("amark", size === "lg" && "amark-lg", agentMeta(agentType).cssClass, className)}
      aria-hidden
    >
      <AgentGlyph agentType={agentType} size={size} />
    </span>
  );
}
