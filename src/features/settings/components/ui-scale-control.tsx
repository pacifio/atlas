import { UiScalePanel as ScalePanel } from "@tryatlas/design";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useSettingsStore } from "../stores/settings-store";
import { clampScale } from "../lib/ui-scale";

/**
 * The interface-scale controls — a stepper, the presets with a preview glyph,
 * and Reset — folded into the account menu's "Interface size" submenu. The
 * same `uiScale` setting the Settings stepper and the `view.zoom*` shortcuts
 * drive; the setting owns the behaviour (native WebView zoom, persisted in
 * Rust), this is only another way to reach it.
 *
 * The panel is the package's; it holds no state, so this wires it to the
 * setting and hands it the keys bound to zoom out and in for the stepper's
 * hints. Its range and presets equal `lib/ui-scale.ts`'s, so the clamp here
 * only restates the setting's own.
 */
export function UiScalePanel() {
  const uiScale = useSettingsStore.use.settings().uiScale;
  const { updateSettings } = useSettingsStore.use.actions();
  const decrease = useActionShortcut("view.zoomOut")?.label;
  const increase = useActionShortcut("view.zoomIn")?.label;

  return (
    <ScalePanel
      scale={uiScale}
      onScaleChange={(next) => updateSettings({ uiScale: clampScale(next) })}
      shortcuts={{ decrease, increase }}
    />
  );
}
