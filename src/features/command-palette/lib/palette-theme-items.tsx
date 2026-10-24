// The palette's three theme rows: "Change theme" and "Change appearance"
// (each a submenu) and "Toggle theme editor". They write the same settings
// the Appearance page writes (`themeLight` / `themeDark`, `themeMode`) and
// open the same floating editor, so nothing here is a second theme path.

import { useEffect } from "react";
import { Monitor, Moon, Palette, Sun } from "lucide-react";
import { toast } from "sonner";
import { Icon } from "@/ui/icon";
import { appearanceForMode } from "@/features/theme/apply-theme";
import type { ThemeMode } from "@/features/theme/lib/theme-api";
import { themeIdFor, useThemeStore } from "@/features/theme/stores/theme-store";
import { useThemeEditorStore } from "@/features/theme/stores/theme-editor-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./command-palette-logic";

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
] as const satisfies readonly { mode: ThemeMode; label: string; icon: typeof Monitor }[];

function Current() {
  return <span className="shrink-0 text-xs text-muted-foreground">Current</span>;
}

export function usePaletteThemeItems() {
  const themeLight = useSettingsStore((s) => s.settings.themeLight);
  const themeDark = useSettingsStore((s) => s.settings.themeDark);
  const themeMode = useSettingsStore((s) => s.settings.themeMode);
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const { load, reapply } = useThemeStore.use.actions();
  const editorOpen = useThemeEditorStore((s) => s.session !== null);
  const editor = useThemeEditorStore.use.actions();

  // The catalog is read once per launch by the Appearance page; the palette
  // may be the first thing to want it.
  useEffect(() => {
    if (themes.length === 0) void load();
  }, [themes.length, load]);

  const showing = themeIdFor({ light: themeLight, dark: themeDark }, themeMode);

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "colours", "palette"],
    title: "Change theme",
    icon: <Icon icon={Palette} size="lg" />,
    placeholder: "Search themes…",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themes.map((theme) => {
          // A theme with one variant fills just that half; one with both is
          // worn light and dark.
          const half = theme.hasLight && theme.hasDark ? null : theme.hasDark ? "dark" : "light";
          const current =
            half === null
              ? themeLight === theme.id && themeDark === theme.id
              : showing === theme.id;
          return {
            kind: "action" as const,
            value: `theme:${theme.id}`,
            title: theme.name,
            description: half ? `For ${half} mode` : undefined,
            searchTerms: [theme.name, theme.author, "theme"],
            icon: <Icon icon={Palette} size="lg" />,
            titleTrailingContent: current ? <Current /> : undefined,
            run: () => {
              const patch: Partial<AppSettings> =
                half === "light"
                  ? { themeLight: theme.id }
                  : half === "dark"
                    ? { themeDark: theme.id }
                    : { themeLight: theme.id, themeDark: theme.id };
              const unchanged =
                (patch.themeLight ?? themeLight) === themeLight &&
                (patch.themeDark ?? themeDark) === themeDark;
              if (unchanged) void reapply();
              else void updateSettings(patch);
              toast.success(`Applied “${theme.name}”`);
            },
          };
        }),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "colour scheme"],
    title: "Change appearance",
    icon: <Icon icon={Monitor} size="lg" />,
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon }) => ({
          kind: "action" as const,
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon icon={icon} size="lg" />,
          titleTrailingContent: themeMode === mode ? <Current /> : undefined,
          run: () => void updateSettings({ themeMode: mode }),
        })),
      },
    ],
  };

  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["toggle theme editor", "theme", "colors", "colours", "customize", "edit"],
    title: "Toggle theme editor",
    icon: <Icon icon={Palette} size="lg" />,
    run: () => {
      if (editorOpen) {
        editor.close();
        return;
      }
      // A user theme is edited in place; a built-in one is duplicated first.
      const builtIn = themes.find((t) => t.id === showing)?.builtIn ?? true;
      editor.open({
        kind: builtIn ? "duplicate" : "edit",
        sourceId: showing,
        initialAppearance: appearanceForMode(themeMode),
      });
    },
  };

  return { changeThemeItem, changeAppearanceItem, themeEditorItem };
}
