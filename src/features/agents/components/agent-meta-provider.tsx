import type { ReactNode } from "react";
import { agentMeta } from "../lib/agent-meta";
import { AgentMetaContext } from "../lib/agent-meta-context";

/**
 * Binds `useAgentMeta` / `useAgentMetaResolver` to the live agent registry.
 *
 * The value is `agentMeta` itself: a stable, non-reactive resolver that reads
 * the registry when it is called. A mark therefore re-resolves when its parent
 * re-renders, exactly as it did when it called `agentMeta` directly. Re-rendering
 * every mark when an agent is installed or removed (a subscription to the
 * registry's `signature`) is a proposed behaviour change awaiting review
 * (ATL-718), not part of this provider.
 */
export function AgentMetaProvider({ children }: { children: ReactNode }) {
  return <AgentMetaContext.Provider value={agentMeta}>{children}</AgentMetaContext.Provider>;
}
