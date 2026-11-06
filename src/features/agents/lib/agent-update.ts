// Updating an installed agent — the one action behind both Update buttons
// (Settings → Agents, and the bar above a chat's composer), and the phase
// text both show while it runs.
//
// The backend does the work either way: a registry bump updates agents on its
// own (idle ones in the background, running ones once their reply finishes),
// and `acp_registry_update` does the same steps on demand. Its progress
// arrives as `agent_update` events on `atlas:agents`, which App.tsx records
// with `setAgentUpdatePhase`; this file only starts an update and names what
// a phase means to a person.

import { toast } from "sonner";
import { isDeadlineError, withDeadline } from "@/features/chat/lib/with-deadline";
import { notifyAgentUpdateFailed } from "@/features/notifications/lib/app-warning-notifier";
import { acpRegistry } from "./agent-registry-api";
import {
  hydrateAgentRegistry,
  setAgentUpdatePhase,
  useAgentRegistryStore,
  type AgentUpdatePhase,
} from "../stores/agent-registry-store";

/** What an update in flight is doing, in words. The wait for a reply is the
 *  part that can take minutes, so it is named rather than left as a spinner. */
export function updatePhaseLabel(phase: AgentUpdatePhase["phase"], version: string): string {
  return phase === "waiting" ? "Waiting for the reply to finish…" : `Installing v${version}…`;
}

/** Long enough for a reply to finish and a large install to land; an
 *  install that outlasts it continues in the backend. */
const UPDATE_DEADLINE_MS = 30 * 60_000;

/** Update `pluginId` to the registry's `version` now. Safe to call twice — a
 *  second call while one is in flight does nothing. Toasts the outcome. */
export async function updateAgent(pluginId: string, name: string, version: string): Promise<void> {
  if (useAgentRegistryStore.getState().updatePhases[pluginId]) return;
  // Shown until the first backend phase replaces it.
  setAgentUpdatePhase(pluginId, { phase: "installing", version });
  try {
    // An update can legitimately take long — it waits for a running reply,
    // then installs — but not forever. Past the deadline the label is
    // released so the button comes back; the backend's `agent_update` events
    // keep reporting the real outcome if it is still going.
    await withDeadline(
      acpRegistry.update(pluginId),
      UPDATE_DEADLINE_MS,
      `Updating ${name} has not finished`,
    );
    // Same id as App.tsx's background-update toast: one update, one toast.
    toast.success(`${name} updated to v${version}`, {
      id: `agent-update:${pluginId}:${version}`,
    });
  } catch (e) {
    if (isDeadlineError(e)) {
      toast.message(`${name} is still updating in the background`);
    } else {
      notifyAgentUpdateFailed({ pluginId, name, version, error: String(e) });
    }
  } finally {
    setAgentUpdatePhase(pluginId, null);
  }
  await hydrateAgentRegistry();
}
