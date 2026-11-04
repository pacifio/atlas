import { useMemo, type ReactNode } from "react";
import { useAgentRegistryStore } from "../stores/agent-registry-store";
import { agentMeta } from "../lib/agent-meta";
import { AgentMetaContext } from "../lib/agent-meta-context";

/**
 * Binds `useAgentMeta` / `useAgentMetaResolver` to the live agent registry.
 *
 * Subscribes to the registry's `signature` only (never the arrays: a selector
 * returning a fresh array is the useShallow infinite-loop trap). A new
 * signature mints a new resolver, so every mark, label and derivation that
 * reads the context re-resolves when an agent is installed, removed or
 * discovered, instead of waiting for its parent to re-render.
 */
export function AgentMetaProvider({ children }: { children: ReactNode }) {
  const signature = useAgentRegistryStore((s) => s.signature);
  // `agentMeta` reads the registry through getState(); the signature is what
  // says it changed, so it is the dependency even though the body never reads it.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const resolve = useMemo(() => (id: string | null | undefined) => agentMeta(id), [signature]);
  return <AgentMetaContext.Provider value={resolve}>{children}</AgentMetaContext.Provider>;
}
