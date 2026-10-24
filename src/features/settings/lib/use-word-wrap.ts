import { useCallback } from "react";
import { useSettingsStore } from "../stores/settings-store";

/**
 * The `wordWrap` setting, as the file tabs and the review diff read it: one
 * global preference, so the wrap button in either header flips it for both,
 * and for every other open file, at once.
 */
export function useWordWrap(): { wrap: boolean; toggle: () => void } {
  const wrap = useSettingsStore((s) => s.settings.wordWrap);
  const toggle = useCallback(() => {
    const { settings, actions } = useSettingsStore.getState();
    actions.updateSettings({ wordWrap: !settings.wordWrap });
  }, []);
  return { wrap, toggle };
}
