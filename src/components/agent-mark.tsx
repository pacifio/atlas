import { cn } from "@/lib/utils";
import type { AgentType } from "@/types/agent";
import { AgentIcons, AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { useAgentMeta } from "@/features/agents/lib/agent-meta-context";

/**
 * The brand icon alone, with no badge around it. Exported for the places that
 * want the mark beside a name in a table row, where the `.amark` box would be
 * a second container around a glyph that is already a contained shape.
 *
 * What identifies the agent is the brand icon itself (agent-icons.tsx) — this
 * is how parallel Claude / Codex chat sessions are told apart. External
 * (registry-installed) agents render their manifest SVG, falling back to a
 * monogram of their label. `AgentMark` below wraps it in the neutral `.amark`
 * chip (`@tryatlas/design`, from `agent.chip.*`); there is no per-agent token family
 * any more — the vendors' hues are constants in `agents/lib/agent-brand.ts`.
 */
export function AgentGlyph({
  agentType,
  size = "sm",
}: {
  agentType: AgentType;
  size?: "sm" | "lg";
}) {
  // First, so the hook order never depends on which branch returns.
  const meta = useAgentMeta(agentType);
  const cls = size === "lg" ? "size-[18px]" : "size-3.5";
  if (agentType === "claude-acp" || agentType === "claude-code")
    return <AgentIcons.Claude className={cls} />;
  if (agentType === "codex-acp" || agentType === "codex")
    return <AgentIcons.Codex className={cls} />;
  if (agentType === "opencode") return <AgentIcons.OpenCode className={cls} />;
  if (agentType === "cursor") return <AgentIcons.Cursor className={cls} />;
  if (agentType === "kilo") return <AgentIcons.Kilo className={cls} />;
  // Atlas's native agent — its own brand mark.
  if (agentType === "atlas-agent") return <AtlasIcon size={size === "lg" ? 18 : 14} />;
  const px = size === "lg" ? 18 : 14;
  // Only recurse when the lookup resolved to a DIFFERENT id: `"claude-code"`
  // resolves to `firstPartyIcon: "claude-code"`, and recursing on the same id was unbounded.
  if (meta.firstPartyIcon && meta.firstPartyIcon !== agentType)
    return <AgentGlyph agentType={meta.firstPartyIcon} size={size} />;
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
    <span className={cn("amark", size === "lg" && "amark-lg", className)} aria-hidden>
      <AgentGlyph agentType={agentType} size={size} />
    </span>
  );
}
