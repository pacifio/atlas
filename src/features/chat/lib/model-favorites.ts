// Starred models for the composer's agent + model picker.
//
// A user preference, so it lives with the other settings in `config.toml`
// (`favoriteModels`) — it survives a reinstall, follows a synced config, and
// every open composer reads the same list through the settings store. Keyed
// per agent as `agentType:modelId`: `claude-code:default` and
// `atlas-agent:default` are different models. The picker spans every agent,
// so the hook does too.

import { useCallback, useMemo } from "react";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

export const favoriteKey = (agentType: string, modelId: string) => `${agentType}:${modelId}`;

/** Every starred `agentType:modelId` key, in the order they were starred. */
export function useModelFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (agentType: string, modelId: string) => void;
} {
  const all = useSettingsStore((s) => s.settings.favoriteModels);
  const favorites = useMemo(() => new Set(all ?? []), [all]);
  const toggle = useCallback((agentType: string, modelId: string) => {
    const key = favoriteKey(agentType, modelId);
    // Read at the action boundary, not from the render's copy: two quick
    // stars must not each write a list missing the other.
    const { settings, actions } = useSettingsStore.getState();
    const cur = settings.favoriteModels ?? [];
    actions.updateSettings({
      favoriteModels: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
    });
  }, []);
  return { favorites, toggle };
}
