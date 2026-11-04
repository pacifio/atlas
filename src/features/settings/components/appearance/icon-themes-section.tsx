/**
 * File and folder icons, beside the colour themes and on their own track
 * (decisions 4 and 11).
 *
 * The grid is what is installed — the bundled Material theme, "Minimal"
 * (Atlas's own lucide icons) and anything the user added. "Add icon theme"
 * searches Open VSX, which decision 11 leaves as the only remote source.
 *
 * Nothing fetches until a person types. A search that fails because the
 * machine is offline says so and leaves the installed list untouched: an icon
 * theme is an ornament, and losing the network must not cost anything already
 * chosen.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useIconThemeStore } from "@/features/icon-theme/stores/icon-theme-store";
import { IconThemePreview } from "@/features/icon-theme/components/icon-theme-preview";
import { appearanceForMode } from "@/features/theme/apply-theme";
import {
  installIconTheme,
  removeIconTheme,
  searchIconThemes,
  MINIMAL_ICON_THEME_ID,
} from "@/features/icon-theme/lib/icon-theme-api";
import type { OpenVsxExtension } from "@/lib/open-vsx";
import { useSettingsStore } from "../../stores/settings-store";
import { SettingsSection } from "../layout/settings-layout";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icon,
  Hint,
} from "@tryatlas/design";

export function IconThemesSection() {
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const themes = useIconThemeStore.use.themes();
  const loading = useIconThemeStore.use.loading();
  const error = useIconThemeStore.use.error();
  const { load } = useIconThemeStore.use.actions();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // The association set a theme would actually be resolved through, so a card
  // previews what applying it would give you. Icon themes have a third
  // ("highContrast") that Atlas never asks for; `appearanceForMode` is the one
  // `applyConfiguredIconTheme` is called with.
  const appearance = appearanceForMode(settings.themeMode);

  return (
    <SettingsSection
      title="File icons"
      anchor="iconTheme"
      action={
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Icon icon={Plus} size="sm" />
          Add icon theme
        </Button>
      }
    >
      <div role="list" className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        {themes.map((theme) => {
          const selected = theme.id === settings.iconTheme;
          return (
            <div key={theme.id} role="listitem" className="flex min-w-0">
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Apply ${theme.name} icon theme`}
                onClick={() => {
                  updateSettings({ iconTheme: theme.id });
                  toast.success(`Applied “${theme.name}” icons`);
                }}
                className={cn(
                  "group flex min-h-20 min-w-0 flex-1 cursor-pointer flex-col justify-between rounded-lg border bg-card p-3 text-left transition-colors",
                  selected ? "border-primary" : "border-border hover:border-border-strong",
                )}
              >
                <IconThemePreview
                  themeId={theme.id}
                  appearance={appearance}
                  className="mb-2.5 h-4"
                />
                <div className="flex w-full items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-foreground">
                        {theme.name}
                      </span>
                      {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                    </div>
                    <p className="truncate text-2xs text-muted-foreground">
                      {theme.author} · {theme.license}
                    </p>
                  </div>
                  {!theme.builtIn && <RemoveButton id={theme.id} name={theme.name} />}
                </div>
                <div className="mt-2 flex items-center gap-1 text-3xs uppercase tracking-wide text-muted-foreground">
                  {theme.id === MINIMAL_ICON_THEME_ID ? (
                    <span>Atlas defaults</span>
                  ) : theme.builtIn ? (
                    <span>Bundled</span>
                  ) : (
                    <span>Installed</span>
                  )}
                  {theme.warnings && theme.warnings.length > 0 && (
                    <Hint label={theme.warnings.map((w) => `${w.key}: ${w.message}`).join("\n")}>
                      <span className="text-warning">
                        {theme.warnings.length} warning{theme.warnings.length === 1 ? "" : "s"}
                      </span>
                    </Hint>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {loading && themes.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
      )}
      {error && <p className="py-4 text-center text-xs text-error">{error}</p>}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[min(36rem,calc(100vh-4rem))] max-w-[min(36rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>Add an icon theme</DialogTitle>
            <DialogDescription>
              Search VS Code icon themes on open-vsx.org. Installing one adds it to the grid.
            </DialogDescription>
          </DialogHeader>
          <OpenVsxSearch />
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function RemoveButton({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();

  return (
    <Hint label={`Remove “${name}”`}>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Remove ${name}`}
        onClick={(event) => {
          // The whole card is the "apply" button, so removing must not also
          // select what it is about to delete.
          event.stopPropagation();
          if (busy) return;
          setBusy(true);
          void removeIconTheme(id)
            .then(() => {
              // Falling back to the bundled default is the only safe landing:
              // the setting would otherwise name a directory that is gone.
              if (settings.iconTheme === id) updateSettings({ iconTheme: "material-icon-theme" });
              toast.success(`Removed “${name}”`);
            })
            .catch((reason: unknown) => toast.error(`Could not remove “${name}”: ${reason}`))
            .finally(() => setBusy(false));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.currentTarget.click();
        }}
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-error group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
      </span>
    </Hint>
  );
}

type SearchState =
  | { phase: "idle" }
  | { phase: "searching" }
  | { phase: "done"; results: OpenVsxExtension[] }
  | { phase: "failed"; message: string };

function OpenVsxSearch() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [installing, setInstalling] = useState<string | null>(null);
  const themes = useIconThemeStore.use.themes();
  const installedIds = useMemo(() => new Set(themes.map((theme) => theme.id)), [themes]);

  // Only the latest search may land: a slow answer to an earlier query must
  // not replace the results of the one after it.
  const latest = useRef(0);

  const run = () => {
    const trimmed = query.trim();
    const request = ++latest.current;
    if (!trimmed) {
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "searching" });
    void searchIconThemes(trimmed)
      .then((results) => {
        if (request === latest.current) setState({ phase: "done", results });
      })
      .catch((reason: unknown) => {
        if (request === latest.current) setState({ phase: "failed", message: String(reason) });
      });
  };

  const install = (hit: OpenVsxExtension) => {
    setInstalling(hit.id);
    void installIconTheme({ namespace: hit.namespace, name: hit.name })
      .then((summary) => toast.success(`Installed “${summary.name}”`))
      .catch((reason: unknown) => toast.error(`Could not install “${hit.displayName}”: ${reason}`))
      .finally(() => setInstalling(null));
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-[28px] items-center gap-1.5 rounded-md border border-border bg-card px-2">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") run();
          }}
          placeholder="Search VS Code icon themes, then press Enter…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <Hint label="Clear">
            <button
              type="button"
              onClick={() => {
                // Retire the search in flight too, so it cannot land after.
                latest.current++;
                setQuery("");
                setState({ phase: "idle" });
              }}
              className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <X size={11} />
            </button>
          </Hint>
        )}
      </div>

      {state.phase === "searching" && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 size={11} className="animate-spin" />
          Searching Open VSX…
        </div>
      )}

      {state.phase === "failed" && (
        <div className="mt-2 rounded-md border border-error/40 bg-error/10 px-2 py-2 text-xs text-error">
          <p>{state.message}</p>
          <button
            type="button"
            onClick={run}
            className="mt-1 cursor-pointer underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      )}

      {state.phase === "done" && state.results.length === 0 && (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No icon themes on Open VSX match “{query}”.
        </div>
      )}

      {state.phase === "done" && state.results.length > 0 && (
        <div className="mt-2 flex min-h-0 flex-col gap-1 overflow-y-auto">
          {state.results.map((hit) => {
            const already = hit.installed || installedIds.has(hit.id);
            const busy = installing === hit.id;
            return (
              <div
                key={hit.id}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {hit.displayName}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {hit.namespace} · {hit.license}
                    </span>
                  </div>
                  <p className="truncate text-2xs text-muted-foreground">{hit.description}</p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => install(hit)}
                  className={cn(
                    "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-2xs font-medium transition-colors",
                    "border border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                  {already ? "Reinstall" : "Install"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
