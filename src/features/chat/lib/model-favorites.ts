// Starred models for the composer's model picker.
//
// A user preference, so it lives with the other settings in `config.toml`
// (`favoriteModels`) — it survives a reinstall, follows a synced config, and
// every open composer reads the same list through the settings store. Keyed
// per agent as `agentType:modelId`: `claude-code:default` and
// `atlas-agent:default` are different models.

import { useCallback, useMemo } from "react";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

const favoriteKey = (agentType: string, modelId: string) => `${agentType}:${modelId}`;

/** The agent's starred model ids, in the order they were starred. */
export function useModelFavorites(agentType: string): {
  favorites: readonly string[];
  toggle: (modelId: string) => void;
} {
  const all = useSettingsStore((s) => s.settings.favoriteModels);
  const favorites = useMemo(() => {
    const prefix = `${agentType}:`;
    return (all ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }, [all, agentType]);
  const toggle = useCallback(
    (modelId: string) => {
      const key = favoriteKey(agentType, modelId);
      // Read at the action boundary, not from the render's copy: two quick
      // stars must not each write a list missing the other.
      const { settings, actions } = useSettingsStore.getState();
      const cur = settings.favoriteModels ?? [];
      actions.updateSettings({
        favoriteModels: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      });
    },
    [agentType],
  );
  return { favorites, toggle };
}
