import { agentMeta, catalogEntry as agentCatalogEntry } from "@/features/agents/lib/agent-meta";
import { canSignIn } from "./agent-signin";
import type { SlashCommand } from "./slash-command-model";

// `commandRequiresArgs` lives in the pure model, not the picker, so the eager
// composer can call it without pulling the lazy picker chunk into the initial
// graph; it is re-exported here for the callers that import it from this file.
export { commandRequiresArgs } from "./slash-command-model";

/** The slash picker's catalogue for an agent: what it advertised over ACP
 *  (`availableCommands`), plus the few commands Atlas itself handles. */
export function buildAgentSlashCommands(
  agentType: string,
  availableCommands: readonly unknown[] | undefined,
): SlashCommand[] {
  // Every agent gets its advertised commands — the native agent included,
  // whose list the seam now publishes. Only the legacy "custom" placeholder
  // bails out.
  if (agentType === "custom") return [];
  const fromAgent: SlashCommand[] = (availableCommands ?? [])
    .map((c) => {
      const o = (c ?? {}) as {
        name?: string;
        description?: string;
        input?: { hint?: string } | null;
      };
      const name = (o.name ?? "").replace(/^\//, "");
      const hint = typeof o.input?.hint === "string" ? o.input.hint : null;
      return {
        name,
        signature: o.input != null ? `/${name} <${hint || "args"}>` : `/${name}`,
        description: o.description ?? "",
        handler: "passthrough" as const,
      };
    })
    .filter((c) => c.name && c.name !== "login");
  // `/login` is the ONE command Atlas synthesizes (S1). Everything else the
  // picker shows is passthrough from the agent's own `availableCommands` —
  // "we render what ACP gives, nothing else".
  //
  // Removed here, deliberately:
  //  - the per-agent `codex-login` / `atlas-login` handlers: every agent now
  //    routes through the same `AgentOAuthModal`, so the fork had no purpose
  //    beyond picking which of three dialogs to open;
  //  - the synthetic `/skills` row: Settings is not an agent command, and
  //    listing it here implied the agent understood it;
  //  - the dimmed `/clear` + `/logout` guard rows for Claude: the adapter
  //    blocklists them from `available_commands_update`, so showing rows that
  //    explain why an unadvertised command does nothing is Atlas inventing
  //    protocol surface. If an agent advertises them, they appear as
  //    passthrough like anything else.
  const login: SlashCommand | null = canSignIn(agentType)
    ? {
        name: "login",
        signature: "/login",
        description: `Sign in to ${agentMeta(agentType).label}.`,
        handler: "agent-login" as const,
      }
    : null;
  // The other Atlas-surface commands. Like /login, these drive app
  // affordances rather than the agent — a new tab, the send queue — so the
  // app is the honest place to synthesize them. /fork is gated on the same
  // capability as the header's "branch from here"; /queue exists for every
  // agent, because the queue does.
  const local: SlashCommand[] = [];
  if (agentCatalogEntry(agentType)?.supportsFork === true) {
    local.push({
      name: "fork",
      signature: "/fork",
      description: "Branch this conversation into a new tab",
      handler: "fork" as const,
    });
  }
  local.push({
    name: "queue",
    signature: "/queue <message>",
    description: "Queue a message to run when the agent is free",
    handler: "queue" as const,
  });
  return [...(login ? [login] : []), ...fromAgent, ...local];
}
