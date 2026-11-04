import { useMemo, type ReactNode } from "react";
import { useAgentRegistryStore } from "../stores/agent-registry-store";
import { agentMeta } from "../lib/agent-meta";
import type { AgentMetaResolver } from "../lib/agent-identity";
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
  const resolve = useMemo(() => resolverFor(signature), [signature]);
  return <AgentMetaContext.Provider value={resolve}>{children}</AgentMetaContext.Provider>;
}

/** A fresh resolver per registry `signature`. `agentMeta` reads the registry
 *  through getState(), so the signature is only what makes the identity new:
 *  a context consumer re-renders exactly when the registry changed. */
function resolverFor(_signature: string): AgentMetaResolver {
  return (id) => agentMeta(id);
}
