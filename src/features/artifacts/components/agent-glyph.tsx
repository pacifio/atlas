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
 *
 * The mark is chosen by the agent's identity, never its id: `useAgentMeta`
 * answers `firstPartyIcon`, and an id that merely contains a first-party name
 * (`claude-foo`, `codex-acp`) gets its registry icon or a monogram (ADR-0002).
 * Aliases belong in `features/agents/lib/agent-identity.ts` (`firstPartyOf`).
 */

import { AgentMonogram, ExternalAgentMark } from "@tryatlas/design";
import { FIRST_PARTY_MARKS } from "@/components/brand-marks";
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
  const meta = useAgentMeta(agent);
  if (meta.firstPartyIcon) {
    // The brand hue is a constant, not a theme key: see `agent-brand.ts`.
    const color = mono ? undefined : agentBrandColor(meta.firstPartyIcon);
    return FIRST_PARTY_MARKS[meta.firstPartyIcon]({ size, color });
  }
  // Registry-installed external agent: manifest SVG, else a monogram.
  if (meta.iconDataUrl) return <ExternalAgentMark dataUrl={meta.iconDataUrl} size={size} />;
  return <AgentMonogram label={meta.label} size={size} />;
}
