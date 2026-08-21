import { defaultAgentForNewSession } from "../lib/default-agent";
import type { SwitchableAgent } from "@/types/agent";

/**
 * The agent a brand-new chat in this tab should start on.
 *
 * Never `null` any more: the answer is the native agent, which is always
 * available, so callers no longer hold off `createSession` waiting on an
 * install/auth probe to settle. The `| null` in the return type is kept so
 * call sites that already guard on it stay correct.
 */
export function useDefaultAgentType(): SwitchableAgent | null {
  return defaultAgentForNewSession();
}
