import { Minus, Plus, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
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
 * The interface-scale popover — the rail footer's quick way to the same
 * `uiScale` setting the Settings stepper and the `view.zoom*` shortcuts drive.
 * The setting owns the behaviour (native WebView zoom, persisted in Rust); this
 * is only another way to reach it.
 */
export function UiScaleControl() {
  const uiScale = useSettingsStore.use.settings().uiScale;
  const { updateSettings } = useSettingsStore.use.actions();
  const setScale = (next: number) => updateSettings({ uiScale: clampScale(next) });
  const pct = Math.round(uiScale * 100);
  const zoomInKeys = useActionShortcut("view.zoomIn")?.label;
  const zoomOutKeys = useActionShortcut("view.zoomOut")?.label;

  return (
    <Popover>
      <Hint label={`Interface scale, ${pct}%`} side="top">
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Interface scale, ${pct}%`}
              className="flex size-[22px] items-center justify-center rounded-full border border-border-subtle text-[var(--muted-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] data-[popup-open]:bg-[var(--atlas-element-hover)] data-[popup-open]:text-[var(--foreground)] cursor-pointer"
            >
              <Type size={12} />
            </button>
          }
        />
      </Hint>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-[232px] p-0 select-none">
        <div className="flex flex-col gap-0.5 px-3 pt-3 pb-2">
          <span className="label text-foreground">Interface scale</span>
          <span className="caption text-muted-foreground">
            Everything grows together — type, controls, spacing.
          </span>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Hint label="Smaller" shortcut={zoomOutKeys}>
            <IconButton
              icon={Minus}
              label="Smaller"
              size="sm"
              variant="outline"
              className="rounded-full"
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
              className="rounded-full"
              disabled={uiScale >= MAX_SCALE}
              onClick={() => setScale(uiScale + SCALE_STEP)}
            />
          </Hint>
        </div>

        <div className="flex flex-col gap-px border-t border-border p-1">
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
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
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

        <div className="border-t border-border p-1">
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
      </PopoverContent>
    </Popover>
  );
}
