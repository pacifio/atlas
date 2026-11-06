// Agent identity for the React tree, without a store.
//
// A view that renders an agent's name or mark calls `useAgentMeta(id)`; a
// container that hands labels to a pure derivation lib passes it
// `useAgentMetaResolver()`. Neither reaches the registry store: the resolver
// comes from context, and `AgentMetaProvider` (mounted in `main.tsx`) is the
// one place that binds it to the live registry.
//
// The default resolves over an EMPTY registry, so a tree rendered without the
// provider (a unit test, a fixture) still names first-party agents and draws a
// monogram for an external one.
//
// On the view-purity contract's `PURE_SHARED_MODULES` list: keep value imports
// to React and `agent-identity.ts`.

import { createContext, useContext } from "react";
import {
  EMPTY_AGENT_REGISTRY,
  resolveAgentMeta,
  type AgentMeta,
  type AgentMetaResolver,
} from "./agent-identity";

const resolveOverEmptyRegistry: AgentMetaResolver = (id) =>
  resolveAgentMeta(id, EMPTY_AGENT_REGISTRY);

export const AgentMetaContext = createContext<AgentMetaResolver>(resolveOverEmptyRegistry);

/** The resolver in scope, for passing into a pure lib (`agentLabel`, `rankBy`…). */
export function useAgentMetaResolver(): AgentMetaResolver {
  return useContext(AgentMetaContext);
}

/** Identity for one agent type or plugin id. Total: a missing id is the native agent. */
export function useAgentMeta(agentTypeOrPluginId: string | null | undefined): AgentMeta {
  return useContext(AgentMetaContext)(agentTypeOrPluginId);
}
