import { useEffect, useState } from "react";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";
import {
  cachedClaudeReady,
  claudeProbeSettled,
  defaultAgentForNewSession,
  FALLBACK_DEFAULT_AGENT,
} from "../lib/default-agent";
import type { SwitchableAgent } from "@/types/agent";

/** Hard cap on how long a new chat waits for the Claude probe before starting
 *  on the fallback agent. The probe is two parallel subprocesses (<100 ms warm),
 *  so this only ever fires when something is genuinely wedged. */
const PROBE_WAIT_MS = 2500;

/**
 * The agent a brand-new chat in this tab should start on, or `null` while the
 * Claude Code probe is still deciding on a first-ever launch (no cached answer
 * to fall back to). Callers hold off `createSession` until it's non-null so the
 * very first chat lands on the right agent instead of defaulting to Claude and
 * stranding the user behind a disabled composer.
 */
export function useDefaultAgentType(): SwitchableAgent | null {
  const phase = useClaudeSetupStore.use.phase();
  const [waited, setWaited] = useState(() => claudeProbeSettled());

  useEffect(() => {
    if (waited) return;
    const t = setTimeout(() => setWaited(true), PROBE_WAIT_MS);
    return () => clearTimeout(t);
  }, [waited]);

  if (phase !== "checking") return defaultAgentForNewSession();
  // Probe still running: a returning user has a cached answer we can trust
  // immediately; a first-ever launch waits (briefly) for a real one.
  const cached = cachedClaudeReady();
  if (cached !== null) return cached ? "claude-code" : FALLBACK_DEFAULT_AGENT;
  return waited ? FALLBACK_DEFAULT_AGENT : null;
}
