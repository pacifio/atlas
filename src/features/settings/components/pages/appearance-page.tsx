/**
 * Everything about how Atlas looks, on one page, each choice drawn as what it
 * gives you: the colour scheme as three pictures of the app, themes and icon
 * themes as live previews, then the interface and its type.
 *
 * Nothing here changes what Atlas does — that is General and the pages after
 * it.
 */

import { Minus, Plus } from "lucide-react";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Select } from "@/ui/select";
import { Hint } from "@/ui/tooltip";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useSettingsStore } from "../../stores/settings-store";
import { APP_ICONS } from "../../lib/app-icons";
import { clampScale, DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, SCALE_STEP } from "../../lib/ui-scale";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingSelect, SettingSlider, SettingSwitch } from "../layout/setting-controls";
import { setInterfaceContrast } from "@/features/theme/apply-theme";
import { repaintTheme } from "@/features/theme/stores/theme-store";
import { ColourSchemeSection } from "../appearance/colour-scheme-section";
import { ThemesSection } from "../appearance/themes-section";
import { IconThemesSection } from "../appearance/icon-themes-section";
import { TypographySection } from "../appearance/typography-section";
import { WELCOME_PALETTE } from "@/features/chat/components/welcome-glow";

const CHAT_WIDTHS = [
  { value: "normal", label: "Normal", description: "760 pixels, the easiest line length to read." },
  { value: "wide", label: "Wide", description: "1080 pixels." },
  { value: "full", label: "Full", description: "The whole panel." },
] as const;

/** A removal and an addition dot, in the status colours each palette draws
 *  diffs with (`globals.css`, `data-diff-palette`). Not the diff variables
 *  themselves: those are already overridden by whichever palette is on. */
function DiffDots({ removed, added }: { removed: string; added: string }) {
  return (
    <span aria-hidden className="flex items-center gap-0.5">
      <span className={cn("size-2 rounded-full", removed)} />
      <span className={cn("size-2 rounded-full", added)} />
    </span>
  );
}

const DIFF_PALETTES = [
  {
    value: "theme",
    label: "Red and green",
    description: "The theme's own colours.",
    icon: <DiffDots removed="bg-error" added="bg-success" />,
  },
  {
    value: "blue-orange",
    label: "Orange and blue",
    description: "Stays distinct with red-green colour blindness.",
    icon: <DiffDots removed="bg-warning" added="bg-info" />,
  },
] as const;

const WELCOME_BACKGROUNDS = [
  { value: "glow", label: "Glow", description: "A soft colour glow from the top edge." },
  { value: "plain", label: "Plain", description: "The theme's own background." },
] as const;

/** A palette entry's dot, drawn by the same hue map as the glow itself. */
function GlowSwatch({ name }: { name: string }) {
  return (
    <span aria-hidden className="atlas-welcome-swatch size-2.5 rounded-full" data-palette={name} />
  );
}

const WELCOME_GLOW_COLORS = [
  {
    value: "random",
    label: "Random",
    description: "A different colour each time a new session opens.",
  },
  ...WELCOME_PALETTE.map((name) => ({
    value: name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    icon: <GlowSwatch name={name} />,
  })),
] as const;

export function AppearancePage() {
  const appIcon = useSettingsStore((s) => s.settings.appIcon);
  const welcomeBackground = useSettingsStore((s) => s.settings.welcomeBackground);
  const { updateSettings } = useSettingsStore.use.actions();

  return (
    <SettingsPage
      title="Appearance"
      description="Themes, icons, fonts, and how the interface is drawn."
    >
      <ColourSchemeSection />
      <ThemesSection />
      <IconThemesSection />

      <SettingsSection title="Interface">
        <SettingsGroup>
          <SettingsRow setting="uiScale" control={<ZoomControl />} />
          <SettingsRow
            setting="interfaceContrast"
            control={
              <SettingSlider
                setting="interfaceContrast"
                step={5}
                unit="%"
                onPreview={(value) => {
                  setInterfaceContrast(value);
                  repaintTheme();
                }}
              />
            }
          />
          <SettingsRow
            setting="chatWidth"
            control={<SettingSelect setting="chatWidth" options={CHAT_WIDTHS} />}
          />
          <SettingsRow setting="showTurnRail" control={<SettingSwitch setting="showTurnRail" />} />
          <SettingsRow
            setting="welcomeBackground"
            control={<SettingSelect setting="welcomeBackground" options={WELCOME_BACKGROUNDS} />}
          />
          <SettingsRow
            setting="welcomeGlowColor"
            disabled={welcomeBackground === "plain"}
            disabledReason="Only applies to the glow background."
            control={
              <SettingSelect
                setting="welcomeGlowColor"
                options={WELCOME_GLOW_COLORS}
                disabled={welcomeBackground === "plain"}
              />
            }
          />
          <SettingsRow
            setting="wordWrap"
            description="In file tabs and diffs. The wrap button in a file's or the review diff's header flips this too. A session's code blocks have their own setting, under Sessions."
            control={<SettingSwitch setting="wordWrap" />}
          />
          <SettingsRow
            setting="diffPalette"
            control={<SettingSelect setting="diffPalette" options={DIFF_PALETTES} />}
          />
          {isMac && (
            <SettingsRow
              setting="appIcon"
              description="The icon in the Dock, Finder and Launchpad. Only the default is live Liquid Glass; the others are fixed renders of it."
              control={
                <Select
                  value={appIcon}
                  aria-label="App icon"
                  options={APP_ICONS.map((icon) => ({ value: icon.id, label: icon.label }))}
                  onValueChange={(next) => void updateSettings({ appIcon: next })}
                />
              }
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <TypographySection />
    </SettingsPage>
  );
}

/** Interface zoom stepper. Also reachable anywhere via the view.zoom* shortcuts. */
function ZoomControl() {
  const uiScale = useSettingsStore((s) => s.settings.uiScale);
  const { updateSettings } = useSettingsStore.use.actions();
  const setScale = (next: number) => void updateSettings({ uiScale: clampScale(next) });
  const zoomIn = useActionShortcut("view.zoomIn")?.label;
  const zoomOut = useActionShortcut("view.zoomOut")?.label;
  const zoomReset = useActionShortcut("view.zoomReset")?.label;

  return (
    <div className="flex items-center gap-1">
      <Hint label="Zoom out" shortcut={zoomOut}>
        <IconButton
          icon={Minus}
          size="sm"
          variant="outline"
          label="Zoom out"
          shape="round"
          disabled={uiScale <= MIN_SCALE}
          onClick={() => setScale(uiScale - SCALE_STEP)}
        />
      </Hint>
      <Hint label="Reset to 100%" shortcut={zoomReset}>
        <Button
          variant="ghost"
          size="sm"
          className="min-w-12 tabular-nums"
          onClick={() => setScale(DEFAULT_SCALE)}
        >
          {Math.round(uiScale * 100)}%
        </Button>
      </Hint>
      <Hint label="Zoom in" shortcut={zoomIn}>
        <IconButton
          icon={Plus}
          size="sm"
          variant="outline"
          label="Zoom in"
          shape="round"
          disabled={uiScale >= MAX_SCALE}
          onClick={() => setScale(uiScale + SCALE_STEP)}
        />
      </Hint>
    </div>
  );
}
