import { createContext, useContext } from "react";

import type { PullRequestAgentActions } from "../lib/use-pull-request-agent-actions";

/** Which pull request the components below are drawing: the checkout `gh`
 *  runs in (images are proxied through it too), the number, and the
 *  repository's web address for autolinks; and the agent actions, so a
 *  review thread deep in the Code tab can offer "Fix in session". */
export interface PullRequestScope {
  repoPath: string;
  number: number;
  repositoryUrl: string | null;
  agent?: Pick<PullRequestAgentActions, "fixFinding" | "pending">;
}

export const PullRequestScopeContext = createContext<PullRequestScope | null>(null);

export function usePullRequestScope(): PullRequestScope {
  const scope = useContext(PullRequestScopeContext);
  if (!scope) throw new Error("usePullRequestScope outside a pull request");
  return scope;
}
