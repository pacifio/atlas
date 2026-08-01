import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";
import { useProjectStore } from "@/features/project/stores/project-store";
import { ATLAS_THEMES, type AtlasTheme } from "@/features/theme/themes";

/**
 * Settings → Appearance → Interface theme. A grid of complete dark palettes; the
 * active one is highlighted and clicking one applies + persists it immediately
 * (live-reskins the whole UI — background, panels, text, borders and accent).
 * Independent of the code-editor syntax theme. Mirrors
 * `code-editor-themes-settings.tsx`.
 */
export function AtlasThemesSettings() {
  const settings = useProjectStore.use.settings();
  const { updateSettings } = useProjectStore.use.actions();
  const active = settings.atlasTheme;
  const [query, setQuery] = useState("");

  const themes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ATLAS_THEMES;
    return ATLAS_THEMES.filter((t) => t.name.toLowerCase().includes(q));
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
                  updateSettings({ atlasTheme: t.id });
                  toast.success(`Applied “${t.name}” theme`);
                }}
                className={cn(
                  "group flex flex-col overflow-hidden rounded-lg border bg-bg-secondary text-left transition-colors outline-none",
                  selected
                    ? "border-[var(--border-strong)]"
                    : "border-border-default hover:border-[var(--border-strong)]",
                )}
              >
                <ThemePreview theme={t} />
                <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-text-primary">
                      {t.name}
                    </span>
                    {selected && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-[#3fb950]"
                        title="Active"
                      />
                    )}
                  </div>
                  <p className="text-[10.5px] leading-snug text-text-tertiary">
                    {t.description}
                  </p>
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

/** A tiny "code line": an indented row of colored token bars, so the editor pane
 *  reads as real syntax-highlighted code rather than plain text bars. */
function CodeLine({
  indent = 0,
  tokens,
}: {
  indent?: number;
  tokens: Array<{ w: string; c: string }>;
}) {
  return (
    <div
      className="flex h-1.5 items-center gap-1"
      style={{ paddingLeft: indent * 8 }}
    >
      {tokens.map((tk, i) => (
        <span
          key={i}
          className="h-1.5 rounded-full"
          style={{ width: tk.w, background: tk.c }}
        />
      ))}
    </div>
  );
}

/** Mini three-pane app window rendered entirely from the theme's own palette —
 *  activity rail + file panel + syntax-highlighted editor + chat panel. Reads as
 *  a complete Atlas window so the tile previews the *whole* skin, not a swatch. */
function ThemePreview({ theme }: { theme: AtlasTheme }) {
  const s = theme.spec;
  // Token colors for the fake code — accent = keyword, secondary = identifier,
  // tertiary = punctuation, muted = comment/string.
  const kw = s.accent;
  const id = s.textSecondary;
  const punc = s.textTertiary;
  const mut = s.textMuted;

  return (
    <div
      className="flex h-[240px] w-full shrink-0 overflow-hidden border-b border-[var(--border-subtle)]"
      style={{ background: s.base }}
    >
      {/* Activity rail */}
      <div
        className="flex w-5 shrink-0 flex-col items-center gap-2 py-2"
        style={{
          background: s.panel,
          borderRight: `1px solid ${s.borderSubtle}`,
        }}
      >
        <span
          className="h-2 w-2 rounded-[3px]"
          style={{ background: s.accent }}
        />
        <span
          className="h-2 w-2 rounded-[3px]"
          style={{ background: s.textTertiary }}
        />
        <span
          className="h-2 w-2 rounded-[3px]"
          style={{ background: s.textGhost }}
        />
        <span
          className="h-2 w-2 rounded-[3px]"
          style={{ background: s.textGhost }}
        />
      </div>

      {/* Pane 1 — file tree */}
      <div
        className="flex w-[26%] shrink-0 flex-col gap-2 p-2"
        style={{
          background: s.panel,
          borderRight: `1px solid ${s.borderSubtle}`,
        }}
      >
        <span
          className="h-1.5 w-1/2 rounded-full"
          style={{ background: s.textTertiary }}
        />
        <span
          className="h-1.5 w-4/5 rounded-full"
          style={{ background: s.textSecondary }}
        />
        <span
          className="-mx-1 h-3 rounded px-1"
          style={{
            background: `color-mix(in srgb, ${s.accent} 16%, transparent)`,
          }}
        >
          <span
            className="mt-[5px] block h-1.5 w-3/5 rounded-full"
            style={{ background: s.accent }}
          />
        </span>
        <span
          className="h-1.5 w-2/3 rounded-full"
          style={{ background: s.textTertiary }}
        />
        <span
          className="h-1.5 w-1/2 rounded-full"
          style={{ background: s.textTertiary }}
        />
        <span
          className="h-1.5 w-3/4 rounded-full"
          style={{ background: s.textGhost }}
        />
      </div>

      {/* Pane 2 — editor with syntax-highlighted dummy code */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        style={{ background: s.base }}
      >
        {/* Tab strip */}
        <div
          className="flex items-center gap-1 px-2 py-1.5"
          style={{ borderBottom: `1px solid ${s.borderSubtle}` }}
        >
          <span
            className="h-2.5 w-10 rounded-t"
            style={{
              background: s.tabActive,
              borderTop: `1px solid ${s.accent}`,
            }}
          />
          <span
            className="h-2.5 w-8 rounded-t"
            style={{ background: s.panel }}
          />
        </div>
        {/* Code body */}
        <div className="flex flex-1 flex-col gap-[7px] p-2.5">
          <CodeLine
            tokens={[
              { w: "22%", c: mut },
              { w: "34%", c: mut },
            ]}
          />
          <CodeLine
            tokens={[
              { w: "18%", c: kw },
              { w: "28%", c: id },
              { w: "10%", c: punc },
            ]}
          />
          <CodeLine
            indent={1}
            tokens={[
              { w: "26%", c: id },
              { w: "14%", c: punc },
              { w: "30%", c: kw },
            ]}
          />
          <CodeLine
            indent={2}
            tokens={[
              { w: "16%", c: kw },
              { w: "40%", c: id },
            ]}
          />
          <CodeLine
            indent={2}
            tokens={[
              { w: "30%", c: id },
              { w: "12%", c: punc },
              { w: "22%", c: mut },
            ]}
          />
          <CodeLine indent={1} tokens={[{ w: "12%", c: punc }]} />
          <CodeLine
            tokens={[
              { w: "20%", c: kw },
              { w: "24%", c: id },
            ]}
          />
        </div>
      </div>

      {/* Pane 3 — chat / assistant */}
      <div
        className="flex w-[24%] shrink-0 flex-col gap-2 p-2"
        style={{
          background: s.panel,
          borderLeft: `1px solid ${s.borderSubtle}`,
        }}
      >
        <div
          className="flex flex-col gap-1 rounded p-1.5"
          style={{ background: s.elevated }}
        >
          <span
            className="h-1.5 w-full rounded-full"
            style={{ background: s.textTertiary }}
          />
          <span
            className="h-1.5 w-3/4 rounded-full"
            style={{ background: s.textTertiary }}
          />
        </div>
        <div
          className="ml-auto flex w-4/5 flex-col gap-1 rounded p-1.5"
          style={{
            background: `color-mix(in srgb, ${s.accent} 18%, transparent)`,
          }}
        >
          <span
            className="h-1.5 w-full rounded-full"
            style={{ background: s.accent }}
          />
          <span
            className="h-1.5 w-2/3 rounded-full"
            style={{ background: s.accent }}
          />
        </div>
        <span
          className="mt-auto h-4 w-full rounded"
          style={{
            background: s.input,
            border: `1px solid ${s.borderDefault}`,
          }}
        />
      </div>
    </div>
  );
}
