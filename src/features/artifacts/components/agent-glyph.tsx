/**
 * The agent's mark.
 *
 * Shared by the Timeline sidebar, the Session detail (timeline nodes and header
 * chip) and the grounded chat. The letter fallback matters: a plugin id we have
 * no mark for still has to render as *something* identifying.
 *
 * `mono` drops the brand tint and inherits the surrounding colour, which is how
 * the chat composer badges its agent.
 *
 * `size` is in pixels, because the callers want genuinely different marks: an
 * 11px chip glyph, and a 16px avatar on the detail's timeline rail where the
 * mark is what identifies the turn.
 */

import { AgentMonogram, ExternalAgentMark } from "@tryatlas/design";
import { AgentIcons, AtlasIcon } from "@/components/brand-marks";
import { agentBrandColor } from "@/features/agents/lib/agent-brand";
import { useAgentMeta } from "@/features/agents/lib/agent-meta-context";

export function AgentGlyph({
  agent,
  mono,
  size = 11,
}: {
  agent: string;
  mono?: boolean;
  size?: number;
}) {
  // First, so the hook order never depends on which branch returns.
  const meta = useAgentMeta(agent);
  // The brand hue is a constant, not a theme key: see `agent-brand.ts`.
  const dim = { width: size, height: size, color: mono ? undefined : agentBrandColor(agent) };
  if (agent.includes("claude")) return <AgentIcons.Claude style={dim} />;
  if (agent.includes("codex")) return <AgentIcons.Codex style={dim} />;
  if (agent.includes("opencode")) return <AgentIcons.OpenCode style={dim} />;
  if (agent.includes("cursor")) return <AgentIcons.Cursor style={dim} />;
  if (agent.includes("kilo")) return <AgentIcons.Kilo style={dim} />;
  if (agent.includes("atlas-agent")) return <AtlasIcon size={size} className="rounded-sm" />;
  // Registry-installed external agent: manifest SVG, else a monogram.
  if (meta.iconDataUrl) return <ExternalAgentMark dataUrl={meta.iconDataUrl} size={size} />;
  return <AgentMonogram label={meta.label} size={size} />;
}
