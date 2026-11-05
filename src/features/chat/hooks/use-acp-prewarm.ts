import { useEffect } from "react";
import { installedExternals } from "@/features/agents/lib/agent-meta";
import { ensureAgent } from "../lib/agents-api";
import { loadCachedAcpModes } from "../lib/acp-modes-cache";

// Once-per-app-session guard for the background Codex pre-warm (below).
let acpPrewarmStarted = false;

export function useAcpPrewarm(): void {
  // Pre-warm secondary ACP agents in the background. The ~3-4s a fresh switch
  // pays is dominated by spawning the adapter (npx / CLI) + the ACP initialize
  // handshake; `ensureAgent` does exactly that (deduped/cached, no session, no
  // auth), so paying it ahead of time makes the actual switch fast. Runs once
  // per app session, deferred and staggered so it never competes with the
  // primary bind.
  //
  // Two gates, and both matter. The agent must be INSTALLED — a hardcoded list
  // of agent names here would have spawned agents the user never asked for,
  // which is exactly what ADR-0002 forbids — and the user must have used it
  // before (a persisted modes cache exists), so we never spawn one they only
  // ever ignore.
  useEffect(() => {
    if (acpPrewarmStarted) return;
    acpPrewarmStarted = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    installedExternals().forEach((agent, i) => {
      const at = agent.agentType;
      if (!loadCachedAcpModes(at)) return; // never used → skip
      timers.push(
        setTimeout(
          () => {
            void ensureAgent(agent.id).catch(() => {
              // Not installed / not ready — the real switch surfaces a proper
              // error; allow a later retry by clearing the once-flag.
              acpPrewarmStarted = false;
            });
          },
          1500 + i * 1000,
        ),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);
}
