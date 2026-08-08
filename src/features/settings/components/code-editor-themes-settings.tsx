import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import { EDITOR_THEMES } from "@/features/editor/themes/themes";
import { CodeEditorThemeThumbnail } from "./code-editor-theme-thumbnail";

/**
 * Settings → Appearance → Editor Theme. Full-width, searchable grid of previews;
 * the active theme is highlighted and clicking one applies + persists it
 * immediately (live-reskins the editor + diff surfaces).
 */
export function CodeEditorThemesSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const active = settings.codeEditorTheme;
  const [query, setQuery] = useState("");

  const themes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EDITOR_THEMES;
    return EDITOR_THEMES.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search — full-width flush bar, like the Skills panel. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search themes…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="shrink-0 cursor-pointer text-text-tertiary hover:text-text-primary"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="grid grid-cols-2 gap-2">
          {themes.map((t) => {
            const selected = t.id === active;
            return (
              <button
                key={t.id}
                onClick={() => {
                  updateSettings({ codeEditorTheme: t.id });
                  toast.success(`Applied “${t.name}” editor theme`);
                }}
                className={cn(
                  "group flex flex-col overflow-hidden rounded-lg border bg-bg-secondary text-left transition-colors outline-none",
                  selected
                    ? "border-[var(--border-strong)]"
                    : "border-border-default hover:border-[var(--border-strong)]",
                )}
              >
                <CodeEditorThemeThumbnail theme={t} />
                <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-text-primary">
                      {t.name}
                    </span>
                    {selected && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[#3fb950]" title="Active" />
                    )}
                  </div>
                  <div className="text-[10.5px] leading-snug text-text-tertiary">
                    {t.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {themes.length === 0 && (
          <div className="py-6 text-center text-[11px] text-text-tertiary">
            No themes match “{query}”.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
