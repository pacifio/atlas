import { useByokStore } from "@/features/settings/stores/byok-store";
import { preferredModels } from "@/features/settings/lib/model-catalog";
import { loadCerseiModelPref } from "./cersei-model-pref";

/** A one-click BYOK (provider, model) for the adaptive card's LLM features
 *  (next-step chips / diagram / commit message). Resolves, in order:
 *   1. the native agent's last-picked model, if its provider still has a key;
 *   2. any configured BYOK provider + its default coding model.
 *  So the features work for ANY user with ANY BYOK key — not just those who
 *  picked a Cersei model. `null` → no key at all → feature gated off. */
export function resolveByok(): { provider: string; model: string } | null {
  const keys = useByokStore.getState().keys;
  const pref = loadCerseiModelPref();
  if (pref?.provider && pref?.model && keys[pref.provider]) return pref;
  for (const provider of Object.keys(keys)) {
    const model = preferredModels(provider)[0];
    if (model) return { provider, model };
  }
  return null;
}
