// An agent's models as the user arranged them in Settings → Agents: the ones
// it advertised plus any the user added by id, in the user's order. The model
// picker and the settings page both list them through here, so the two agree.

import type { AgentCatalogEntry } from "@/types/agent-catalog";
import type { SessionModeInfo } from "@/types/agents";

/** Marks a model the agent didn't advertise. */
export interface ArrangedModel extends SessionModeInfo {
  custom?: boolean;
}

/** `advertised` plus the user's custom models, ordered by `modelOrder`; ids
 *  the order doesn't name keep their place after the ones it does. */
export function arrangeModels(
  entry: Pick<AgentCatalogEntry, "customModels" | "modelOrder"> | null | undefined,
  advertised: readonly SessionModeInfo[],
): ArrangedModel[] {
  if (!entry) return [...advertised];
  const known = new Set(advertised.map((m) => m.id));
  const models: ArrangedModel[] = [
    ...advertised,
    ...entry.customModels
      .filter((m) => !known.has(m.id))
      .map((m) => ({ id: m.id, name: m.name || m.id, custom: true })),
  ];
  if (entry.modelOrder.length === 0) return models;
  const rank = new Map(entry.modelOrder.map((id, i) => [id, i]));
  // Stable: unranked models keep the agent's order, after the ranked ones.
  return models
    .map((model, i) => ({ model, key: rank.get(model.id) ?? entry.modelOrder.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ model }) => model);
}
