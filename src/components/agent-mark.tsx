import { cn } from "@/lib/utils";
import type { AgentType } from "@/types/agent";
import { AgentIcons } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";

/**
 * Small per-agent identity badge. Reuses the `.amark` + `.agent-*` token
 * system (tokens.css) and renders the agent's brand icon (agent-icons.tsx) —
 * this is how parallel Claude / Codex chat sessions are told apart by icon.
 */
const AGENT_CLASS: Record<AgentType, string> = {
  "claude-code": "agent-claude",
  codex: "agent-codex",
  opencode: "agent-opencode",
  cersei: "agent-cersei",
  custom: "",
};

function AgentGlyph({ agentType, size }: { agentType: AgentType; size: "sm" | "lg" }) {
  const cls = size === "lg" ? "size-[18px]" : "size-3.5";
  if (agentType === "claude-code") return <AgentIcons.Claude className={cls} />;
  if (agentType === "codex") return <AgentIcons.Codex className={cls} />;
  if (agentType === "opencode") return <AgentIcons.OpenCode className={cls} />;
  // Atlas's native agent — its own brand mark.
  if (agentType === "cersei") return <AtlasIcon size={size === "lg" ? 18 : 14} />;
  return <span className="font-mono">?</span>;
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
      className={cn("amark", size === "lg" && "amark-lg", AGENT_CLASS[agentType], className)}
      aria-hidden
    >
      <AgentGlyph agentType={agentType} size={size} />
    </span>
  );
}
