/**
 * The theme library: every installed theme as a live miniature, and the way
 * in for new ones.
 *
 * Atlas wears two themes, one while it is light and one while it is dark
 * (`themeLight`, `themeDark`). Picking a card uses that theme for both; the
 * light and dark orbs on a card set just one half, so a light theme from one family
 * can sit beside a dark one from another. A ring on an orb marks the half a
 * theme is filling. Importing opens in a dialog over the page — a shadcn, Zed
 * or VS Code theme converted by Rust, with the report of what mapped shown
 * before anything is written (`theme-import-panel.tsx`). Creating, duplicating
 * and editing open the theme editor, which floats over the whole app
 * (`theme-editor-panel.tsx`), so it outlives this page.
 */

import { memo, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Download, Moon, Pencil, Plus, Sun } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { appearanceForMode } from "@/features/theme/apply-theme";
import { useThemeEditorStore } from "@/features/theme/stores/theme-editor-store";
import { themeIdFor, useThemeStore } from "@/features/theme/stores/theme-store";
import { previewTheme, type ThemePreview } from "@/features/theme/preview-theme";
import type { ThemeSummary } from "@/features/theme/lib/theme-api";
import type { AppSettings } from "../../lib/app-settings";
import { useSettingsStore } from "../../stores/settings-store";
import { SettingsSection } from "../layout/settings-layout";
import { ThemeImportPanel } from "../theme-import-panel";
import type { Theme, ThemeAppearance } from "@tryatlas/design/theme";
import { Button, Dialog, DialogContent, Icon, Hint } from "@tryatlas/design";

export function ThemesSection() {
  const themeLight = useSettingsStore((s) => s.settings.themeLight);
  const themeDark = useSettingsStore((s) => s.settings.themeDark);
  const themeMode = useSettingsStore((s) => s.settings.themeMode);
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useThemeStore.use.themes();
  const loaded = useThemeStore.use.loaded();
  const skipped = useThemeStore.use.skipped();
  const loading = useThemeStore.use.loading();
  const error = useThemeStore.use.error();
  const { load, loadAll, reapply } = useThemeStore.use.actions();
  const [importing, setImporting] = useState(false);
  const { open: openEditor } = useThemeEditorStore.use.actions();

  useEffect(() => {
    void load();
  }, [load]);

  // Every card resolves a full theme document, and the catalog only carries
  // summaries. Keyed on `themes` rather than run once, so the batch re-runs
  // after the file watcher drops the cache; `loadAll` skips what it already has.
  useEffect(() => {
    void loadAll();
  }, [loadAll, themes]);

  const showing = themeIdFor({ light: themeLight, dark: themeDark }, themeMode);

  const onPick = useCallback(
    (id: string, name: string, half: ThemeAppearance | "both") => {
      const patch: Partial<AppSettings> =
        half === "light"
          ? { themeLight: id }
          : half === "dark"
            ? { themeDark: id }
            : { themeLight: id, themeDark: id };
      // Writing the values already set changes nothing, and
      // `applySettingsSideEffects` — rightly — skips it. That made the obvious
      // way to pick up a hand-edit ("click it again") do nothing at all, so
      // ask the theme store directly instead.
      const unchanged =
        (patch.themeLight ?? themeLight) === themeLight &&
        (patch.themeDark ?? themeDark) === themeDark;
      if (unchanged) void reapply();
      else void updateSettings(patch);
      toast.success(half === "both" ? `Applied “${name}”` : `“${name}” is now your ${half} theme`);
    },
    [themeLight, themeDark, reapply, updateSettings],
  );

  // Whichever half is on screen is the one the editor starts on, so the first
  // change made is the first change seen.
  const onEdit = useCallback(
    (sourceId: string, kind: "create" | "duplicate" | "edit") =>
      openEditor({ kind, sourceId, initialAppearance: appearanceForMode(themeMode) }),
    [openEditor, themeMode],
  );

  return (
    <SettingsSection
      title="Themes"
      anchor="themeLight"
      description="Pick a theme for both light and dark, or one of its orbs to set just that half."
      action={
        <div className="flex items-center gap-1">
          <Hint label="Convert a shadcn, Zed or VS Code theme">
            <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
              <Icon icon={Download} size="sm" />
              Import theme
            </Button>
          </Hint>
          <Hint label="Start from two colours of the theme you're using">
            <Button size="sm" variant="ghost" onClick={() => onEdit(showing, "create")}>
              <Icon icon={Plus} size="sm" />
              Create theme
            </Button>
          </Hint>
        </div>
      }
    >
      {/* A file Rust could not load is skipped rather than fatal, which is
          what keeps the catalog alive — but it also means the theme you
          just saved simply never appears, with no clue why. Silent on a
          healthy install; the whole point on a broken one. */}
      {skipped.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning-muted p-2.5">
          <div className="flex items-center gap-1.5">
            <Icon icon={AlertTriangle} size="sm" className="text-warning" />
            <span className="text-xs font-medium text-foreground">
              {skipped.length === 1
                ? "1 theme file was skipped"
                : `${skipped.length} theme files were skipped`}
            </span>
          </div>
          <ul className="mt-1.5 space-y-1">
            {skipped.map((warning) => (
              <li key={warning.key} className="text-2xs leading-snug text-muted-foreground">
                <span className="font-medium text-secondary-foreground">{warning.key}</span> —{" "}
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            summary={theme}
            full={loaded[theme.id]}
            showing={theme.id === showing}
            isLight={theme.id === themeLight}
            isDark={theme.id === themeDark}
            onPick={onPick}
            onEdit={onEdit}
          />
        ))}
      </div>

      {loading && themes.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
      )}
      {error && <p className="py-6 text-center text-xs text-error">{error}</p>}

      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent
          size="lg"
          showCloseButton={false}
          className="h-[min(40rem,calc(100vh-4rem))] gap-0 overflow-hidden p-0"
        >
          <ThemeImportPanel
            themes={themes}
            onClose={() => setImporting(false)}
            onImported={(id) => {
              // The watcher will re-list the catalog; applying it here is what
              // makes the import visibly land.
              void updateSettings({ themeLight: id, themeDark: id });
              void load();
            }}
          />
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

/**
 * One theme in the grid: an orb for each variant it has, and its name.
 *
 * An orb is the variant's background lit by its brand colour — the two
 * colours a theme is recognised by, and all a choice between themes needs.
 * (The full window miniature this replaced showed every role at once and
 * read as noise at grid size.) Clicking the card uses the theme for both
 * halves; clicking an orb sets just that one, and a ring marks the halves
 * this theme fills.
 *
 * Memoised: every prop is stable, so hovering one card re-renders no other.
 */
const ThemeCard = memo(function ThemeCard({
  summary,
  full,
  showing,
  isLight,
  isDark,
  onPick,
  onEdit,
}: {
  summary: ThemeSummary;
  /** `undefined` until `loadAll` has the document. */
  full: Theme | undefined;
  /** This is the theme on screen right now. */
  showing: boolean;
  isLight: boolean;
  isDark: boolean;
  onPick: (id: string, name: string, half: ThemeAppearance | "both") => void;
  onEdit: (sourceId: string, kind: "duplicate" | "edit") => void;
}) {
  const light = full && summary.hasLight ? previewTheme(full, "light") : null;
  const dark = full && summary.hasDark ? previewTheme(full, "dark") : null;

  return (
    <button
      type="button"
      onClick={() => onPick(summary.id, summary.name, "both")}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border bg-card px-3 pt-4 pb-2.5 text-left outline-none",
        "transition-colors duration-fast ease-out-strong focus-visible:ring-1 focus-visible:ring-ring",
        showing ? "border-primary" : "border-border hover:border-border-strong",
      )}
    >
      <div className="flex h-11 items-center justify-center gap-4">
        {full ? (
          <>
            <Orb half="light" theme={summary} preview={light} chosen={isLight} onPick={onPick} />
            <Orb half="dark" theme={summary} preview={dark} chosen={isDark} onPick={onPick} />
          </>
        ) : (
          // The document is one `get_theme` away; hold the orbs' place.
          <>
            <span className="size-11 rounded-full bg-element-selected" />
            <span className="size-11 rounded-full bg-element-selected" />
          </>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-medium text-foreground">{summary.name}</span>
        {/* A theme that loaded but carries keys Atlas does not know. Those
            keys are preserved, not applied, so the author sees the name
            they typed do nothing until they are told. */}
        {summary.warnings.length > 0 && (
          <Hint
            label={
              <span className="block max-w-64 whitespace-pre-line text-left">
                {summary.warnings.map((warning) => `${warning.key}: ${warning.message}`).join("\n")}
              </span>
            }
          >
            <span
              aria-label={`${summary.warnings.length} unknown theme key(s)`}
              className="flex shrink-0 items-center gap-0.5 text-2xs text-warning"
            >
              <Icon icon={AlertTriangle} size="xs" />
              {summary.warnings.length}
            </span>
          </Hint>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within:opacity-100 group-hover:opacity-100">
          {/* A built-in is rebuilt with every release, so it is duplicated
              rather than edited: the copy is the user's and stays put. */}
          {!summary.builtIn && (
            <CardAction
              icon={Pencil}
              label={`Edit ${summary.name}`}
              onAct={() => onEdit(summary.id, "edit")}
            />
          )}
          <CardAction
            icon={Copy}
            label={`Duplicate ${summary.name}`}
            onAct={() => onEdit(summary.id, "duplicate")}
          />
        </span>
      </div>
    </button>
  );
});

/** A small action on a card; a `<span role="button">` for the reason `Orb` gives. */
function CardAction({
  icon,
  label,
  onAct,
}: {
  icon: typeof Copy;
  label: string;
  onAct: () => void;
}) {
  return (
    <Hint label={label}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onAct();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onAct();
          }
        }}
        className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-element-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon icon={icon} size="xs" />
      </span>
    </Hint>
  );
}

/**
 * A theme's light or dark variant as an orb: its background, lit from below
 * by its brand colour. Chosen, it wears a ring and a sun or moon badge saying
 * which half it fills.
 *
 * A `<span role="button">` rather than a `<button>`: the whole card is already
 * the pick-both control, and a nested `<button>` is invalid inside it. The
 * `stopPropagation` keeps setting one half from also setting both.
 */
function Orb({
  half,
  theme,
  preview,
  chosen,
  onPick,
}: {
  half: ThemeAppearance;
  theme: ThemeSummary;
  /** `null` when this theme has no such variant. */
  preview: ThemePreview | null;
  chosen: boolean;
  onPick: (id: string, name: string, half: ThemeAppearance | "both") => void;
}) {
  if (!preview) return null;
  const { background, primary } = preview.swatch;
  const label = chosen
    ? `${theme.name} is your ${half} theme`
    : `Use ${theme.name} as your ${half} theme`;
  const pick = () => onPick(theme.id, theme.name, half);
  return (
    <Hint label={label}>
      <span
        role="button"
        tabIndex={0}
        aria-pressed={chosen}
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          pick();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            pick();
          }
        }}
        className={cn(
          "relative flex size-11 cursor-pointer rounded-full outline-none",
          "ring-offset-2 ring-offset-card transition-shadow duration-fast ease-out-strong",
          "focus-visible:ring-1 focus-visible:ring-ring",
          chosen ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-border-strong",
        )}
      >
        <span
          aria-hidden
          className="size-full rounded-full border border-border-subtle"
          style={{
            background: `radial-gradient(circle at 50% 30%, ${background} 25%, color-mix(in oklab, ${primary} 70%, ${background}) 120%)`,
          }}
        />
        {chosen && (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-card text-foreground">
            <Icon icon={half === "light" ? Sun : Moon} size="xs" />
          </span>
        )}
      </span>
    </Hint>
  );
}
