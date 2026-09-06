import { AgentMark } from "atlas";

/**
 * Per-agent identity badge — how parallel chat sessions are told apart.
 * Reuses the `.amark` + `.agent-*` token system from tokens.css.
 *
 * NOTE: pass an id `AgentGlyph` early-returns on. `"claude-code"` and
 * `"codex"` (the literals `FirstPartyAgent` declares) recurse forever —
 * see NOTES.md.
 */
const AGENTS: Array<[string, string]> = [
  ["claude-acp", "Claude Code"],
  ["codex-acp", "Codex"],
  ["opencode", "OpenCode"],
  ["cursor", "Cursor"],
  ["kilo", "Kilo"],
  ["cersei", "Atlas"],
];

export const AllAgents = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    {AGENTS.map(([id]) => (
      <AgentMark key={id} agentType={id} />
    ))}
  </div>
);

export const Large = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    {AGENTS.map(([id]) => (
      <AgentMark key={id} agentType={id} size="lg" />
    ))}
  </div>
);

export const InASessionList = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>
    {[
      ["claude-acp", "Fix the scroll blanking"],
      ["codex-acp", "Port the ACP registry"],
      ["cersei", "Draft release notes"],
    ].map(([id, title]) => (
      <div key={id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AgentMark agentType={id} />
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{title}</span>
      </div>
    ))}
  </div>
);

export const Labelled = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    {AGENTS.map(([id, label]) => (
      <div key={id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AgentMark agentType={id} size="lg" />
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{label}</span>
      </div>
    ))}
  </div>
);
