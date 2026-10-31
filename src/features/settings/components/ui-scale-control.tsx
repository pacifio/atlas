import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useSettingsStore } from "../stores/settings-store";
import {
  clampScale,
  DEFAULT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  SCALE_PRESETS,
  SCALE_STEP,
} from "../lib/ui-scale";

/** The preview glyph per preset, on the type scale rather than an inline
 *  `fontSize`, so the column shows real steps the interface moves through. */
const PREVIEW_CLASS = ["text-xs", "text-sm", "text-md", "text-lg"] as const;

/**
 * The interface-scale controls — a stepper, the presets with a preview glyph,
 * and Reset — folded into the account menu's "Interface size" submenu. The
 * same `uiScale` setting the Settings stepper and the `view.zoom*` shortcuts
 * drive; the setting owns the behaviour (native WebView zoom, persisted in
 * Rust), this is only another way to reach it.
 *
 * Plain buttons rather than menu items, so a step or a preset applies without
 * closing the menu: the point is to watch the interface change.
 */
export function UiScalePanel() {
  const uiScale = useSettingsStore.use.settings().uiScale;
  const { updateSettings } = useSettingsStore.use.actions();
  const setScale = (next: number) => updateSettings({ uiScale: clampScale(next) });
  const pct = Math.round(uiScale * 100);
  const zoomInKeys = useActionShortcut("view.zoomIn")?.label;
  const zoomOutKeys = useActionShortcut("view.zoomOut")?.label;

  return (
    <div className="flex flex-col p-0.5 select-none">
      {/* Two surfaces, the agent/model picker's recipe: the menu is the
        surround carrying the title and Reset, and the controls sit
        in an inset card on the app's own background, its edge carried by
        a hairline ring and a shadow. */}
      <div className="flex flex-col gap-0.5 px-1.5 pt-1 pb-2.5">
        <span className="label text-foreground">Interface scale</span>
        <span className="caption text-muted-foreground">
          Everything grows together — type, controls, spacing.
        </span>
      </div>

      <div className="overflow-hidden rounded-lg bg-background shadow-sm ring-1 ring-border">
        <div className="flex items-center gap-2 border-b border-foreground/8 px-2 py-1.5">
          <Hint label="Smaller" shortcut={zoomOutKeys}>
            <IconButton
              icon={Minus}
              label="Smaller"
              size="sm"
              variant="outline"
              shape="round"
              disabled={uiScale <= MIN_SCALE}
              onClick={() => setScale(uiScale - SCALE_STEP)}
            />
          </Hint>
          <span className="flex-1 text-center text-xs font-medium tabular-nums text-foreground">
            {pct}%
          </span>
          <Hint label="Larger" shortcut={zoomInKeys}>
            <IconButton
              icon={Plus}
              label="Larger"
              size="sm"
              variant="outline"
              shape="round"
              disabled={uiScale >= MAX_SCALE}
              onClick={() => setScale(uiScale + SCALE_STEP)}
            />
          </Hint>
        </div>

        <div className="flex flex-col gap-px p-1">
          {SCALE_PRESETS.map((preset, i) => {
            const active = Math.abs(preset.value - uiScale) < 0.001;
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => setScale(preset.value)}
                className={cn(
                  "flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs cursor-pointer",
                  "transition-colors duration-fast ease-out-strong",
                  active
                    ? "bg-foreground/8 text-foreground"
                    : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
                )}
              >
                <span
                  className={cn("w-5 text-center font-semibold leading-none", PREVIEW_CLASS[i])}
                >
                  A
                </span>
                <span className="flex-1">{preset.label}</span>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {Math.round(preset.value * 100)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={uiScale === DEFAULT_SCALE}
          onClick={() => setScale(DEFAULT_SCALE)}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}
