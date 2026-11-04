import type { ReactNode } from "react";
import {
  AgentMonogram,
  AtlasMark,
  ClaudeCodeMark,
  CodexMark,
  CursorAgentMark,
  ExternalAgentMark,
  KiloMark,
  OpenCodeMark,
  type BrandMarkProps,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { AgentType, FirstPartyAgent } from "@/types/agent";
import { useAgentMeta } from "@/features/agents/lib/agent-meta-context";

/**
 * Agent marks, drawn from `@tryatlas/design`. Nothing here holds an SVG path:
 * the vendor glyphs live in the package (its notices name their sources), and
 * this file only decides which one an agent gets.
 *
 * That decision is the agent's identity, not its id. `AgentGlyph` reads
 * `useAgentMeta(agentType).firstPartyIcon` and looks the mark up in
 * `FIRST_PARTY_MARKS`; it never compares the id itself (ADR-0002). An alias
 * such as `claude-acp` drawing the Claude Code mark is decided in
 * `features/agents/lib/agent-identity.ts` (`firstPartyOf`), and that is where
 * a new one goes.
 */

type MarkProps = { size: number; color?: string; className?: string };

/** One mark per first-party agent. `size` is the box in px; `color` the ink
 *  (omitted where the surrounding chip supplies it). */
export const FIRST_PARTY_MARKS: Record<FirstPartyAgent, (p: MarkProps) => ReactNode> = {
  "claude-code": ({ size, color, className }) => (
    <ClaudeCodeMark className={className} style={{ width: size, height: size, color }} />
  ),
  codex: ({ size, color, className }) => (
    <CodexMark className={className} style={{ width: size, height: size, color }} />
  ),
  opencode: ({ size, color, className }) => (
    <OpenCodeMark className={className} style={{ width: size, height: size, color }} />
  ),
  cursor: ({ size, color, className }) => (
    <CursorAgentMark className={className} style={{ width: size, height: size, color }} />
  ),
  kilo: ({ size, color, className }) => (
    <KiloMark className={className} style={{ width: size, height: size, color }} />
  ),
  // Named like the other agent marks (the package draws `AtlasMark` decorative).
  "atlas-agent": ({ size, className }) => (
    <AtlasMark
      role="img"
      aria-hidden={false}
      aria-label="Atlas"
      className={className}
      style={{ width: size, height: size }}
    />
  ),
};

/** `1em` by default, so a site that sizes by font or `style` keeps its size. */
function emSized(Mark: (p: BrandMarkProps) => ReactNode) {
  return function EmSizedMark(props: BrandMarkProps) {
    return <Mark width="1em" height="1em" {...props} />;
  };
}

/** The first-party marks as plain components, for the sites that tint and
 *  size them themselves (`<AgentIcons.Claude style={{ color }} />`). */
export const AgentIcons = {
  Claude: emSized(ClaudeCodeMark),
  Codex: emSized(CodexMark),
  OpenCode: emSized(OpenCodeMark),
  Cursor: emSized(CursorAgentMark),
  Kilo: emSized(KiloMark),
};

/**
 * The brand icon alone, with no badge around it. Exported for the places that
 * want the mark beside a name in a table row, where the `.amark` box would be
 * a second container around a glyph that is already a contained shape.
 *
 * What identifies the agent is the brand icon itself — this is how parallel
 * Claude / Codex sessions are told apart. External (registry-installed)
 * agents render their manifest SVG, falling back to a monogram of their
 * label. `AgentMark` below wraps it in the neutral `.amark` chip
 * (`@tryatlas/design`, from `agent.chip.*`); there is no per-agent token
 * family any more — the vendors' hues are constants in
 * `agents/lib/agent-brand.ts`.
 */
export function AgentGlyph({
  agentType,
  size = "sm",
}: {
  agentType: AgentType;
  size?: "sm" | "lg";
}) {
  const meta = useAgentMeta(agentType);
  const px = size === "lg" ? 18 : 14;
  const cls = size === "lg" ? "size-[18px]" : "size-3.5";
  if (meta.firstPartyIcon)
    return FIRST_PARTY_MARKS[meta.firstPartyIcon]({ size: px, className: cls });
  if (meta.iconDataUrl) return <ExternalAgentMark dataUrl={meta.iconDataUrl} size={px} />;
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
