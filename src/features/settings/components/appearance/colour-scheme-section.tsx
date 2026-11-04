/**
 * System / Light / Dark, as three pictures of the app rather than three words.
 *
 * Each card sketches the app in what that choice gives you: Light in your
 * light theme, Dark in your dark one, and System both, split down the middle. A
 * theme with only one variant draws that one — which is also what Atlas would
 * show (`resolveTheme` falls back to the variant it has).
 */

import { cn } from "@/lib/utils";
import { previewTheme, type ThemePreview } from "@/features/theme/preview-theme";
import { useThemeStore } from "@/features/theme/stores/theme-store";
import { useSettingsStore } from "../../stores/settings-store";
import { SettingsSection } from "../layout/settings-layout";
import type { ThemeMode } from "@tryatlas/design/theme";

const MODES = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
] as const satisfies readonly { mode: ThemeMode; label: string }[];

export function ColourSchemeSection() {
  const themeMode = useSettingsStore((s) => s.settings.themeMode);
  const themeLight = useSettingsStore((s) => s.settings.themeLight);
  const themeDark = useSettingsStore((s) => s.settings.themeDark);
  const { updateSettings } = useSettingsStore.use.actions();
  const lightTheme = useThemeStore((s) => s.loaded[themeLight]);
  const darkTheme = useThemeStore((s) => s.loaded[themeDark]);
  const light = lightTheme ? previewTheme(lightTheme, "light") : null;
  const dark = darkTheme ? previewTheme(darkTheme, "dark") : null;
  const index = Math.max(
    0,
    MODES.findIndex((m) => m.mode === themeMode),
  );

  // A radio group: one tab stop, arrows move the choice, as a native one does.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + MODES.length) % MODES.length;
    void updateSettings({ themeMode: MODES[next].mode });
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return (
    <SettingsSection title="Colour scheme" anchor="themeMode">
      <div
        role="radiogroup"
        aria-label="Colour scheme"
        onKeyDown={onKeyDown}
        className="grid grid-cols-3 gap-3"
      >
        {MODES.map(({ mode, label }) => {
          const active = themeMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => void updateSettings({ themeMode: mode })}
              className={cn(
                "flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-2 text-left outline-none",
                "transition-colors duration-fast ease-out-strong focus-visible:ring-1 focus-visible:ring-ring",
                active ? "border-primary" : "border-border hover:border-border-strong",
              )}
            >
              <SchemePicture mode={mode} light={light} dark={dark} />
              <span
                className={cn(
                  "text-center text-xs",
                  active ? "font-medium text-foreground" : "text-secondary-foreground",
                )}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function SchemePicture({
  mode,
  light,
  dark,
}: {
  mode: ThemeMode;
  light: ThemePreview | null;
  dark: ThemePreview | null;
}) {
  // `w-full`: WebKit does not stretch a flex child of a `<button>`, so the
  // frame would otherwise shrink to its content in the app (not in Chrome).
  const frame = "relative h-28 w-full overflow-hidden rounded-md border border-border-subtle";
  // The document is one `get_theme` away; hold the card's height meanwhile.
  if (!light || !dark) return <div className={cn(frame, "bg-element-selected")} />;
  if (mode !== "system") {
    return (
      <div className={frame}>
        <SchemeSketch preview={mode === "light" ? light : dark} />
      </div>
    );
  }
  return (
    <div className={frame}>
      <SchemeSketch preview={light} />
      <SchemeSketch preview={dark} className="absolute inset-0 [clip-path:inset(0_0_0_50%)]" />
    </div>
  );
}

/**
 * Atlas's own window, pared down to shapes: the titlebar, the project
 * sidebar with one row selected, a chat (a message you sent, the reply, the
 * composer and its send button) and the source-control panel listing changed
 * files. A colour scheme is about surfaces against each other, so the sketch
 * draws surfaces, hairlines, text weight and the one accent, and nothing that
 * would make two themes look different for reasons other than light and dark.
 *
 * `preview.vars` scopes every utility below to the previewed theme.
 */
function SchemeSketch({ preview, className }: { preview: ThemePreview; className?: string }) {
  return (
    <div
      aria-hidden
      style={preview.vars}
      className={cn("flex size-full flex-col bg-background", className)}
    >
      {/* Titlebar. */}
      <div className="flex h-3 shrink-0 items-center gap-0.5 border-b border-border-subtle bg-sidebar px-1.5">
        <span className="size-1 rounded-full bg-border-strong" />
        <span className="size-1 rounded-full bg-border-strong" />
        <span className="size-1 rounded-full bg-border-strong" />
        <span className="ml-2 h-1 w-6 rounded-full bg-element-selected" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Project sidebar. */}
        <div className="flex w-1/5 shrink-0 flex-col gap-1 border-r border-border-subtle bg-sidebar p-1.5">
          <Text className="w-3/5" />
          <div className="flex h-2 items-center rounded-sm bg-element-selected px-1">
            <Text className="w-4/5" strong />
          </div>
          <Text className="w-2/3" />
          <Text className="w-1/2" />
        </div>

        {/* Chat. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
          <div className="ml-auto flex h-3 w-2/5 items-center rounded-sm bg-element-selected px-1">
            <Text className="w-full" strong />
          </div>
          <Text className="w-4/5" strong />
          <Text className="w-3/5" />
          <Text className="w-2/3" />
          <div className="mt-auto flex h-4 items-center rounded-md border border-border bg-card px-1.5">
            <Text className="w-1/3" />
            <span className="ml-auto size-2 rounded-full bg-primary" />
          </div>
        </div>

        {/* Source control. */}
        <div className="flex w-1/4 shrink-0 flex-col gap-1 border-l border-border-subtle bg-sidebar p-1.5">
          <Text className="w-1/2" strong />
          <FileRow dot="bg-warning" width="w-3/4" />
          <FileRow dot="bg-success" width="w-1/2" />
          <FileRow dot="bg-error" width="w-2/3" />
        </div>
      </div>
    </div>
  );
}

/** A line of text, as a bar: foreground when `strong`, muted otherwise. */
function Text({ className, strong }: { className?: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        "block h-0.5 shrink-0 rounded-full",
        strong ? "bg-muted-foreground" : "bg-border-strong",
        className,
      )}
    />
  );
}

/** A changed file: its status colour, then its name. */
function FileRow({ dot, width }: { dot: string; width: string }) {
  return (
    <span className="flex items-center gap-0.5">
      <span className={cn("size-1 shrink-0 rounded-full", dot)} />
      <Text className={width} />
    </span>
  );
}
