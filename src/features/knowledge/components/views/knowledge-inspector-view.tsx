import { useId, useState } from "react";
import { ChevronRight, Link2, ListTree } from "lucide-react";
import { EmptyState, Icon } from "@tryatlas/design";
import { cn } from "@/lib/utils";

export interface OutlineHeading {
  id: string;
  label: string;
  level: 2 | 3;
}

export interface InspectorBacklink {
  fromEntryId: string;
  fromTitle: string;
  snippet: string;
}

const TABS = [
  { id: "outline", label: "Outline" },
  { id: "links", label: "Backlinks" },
] as const;

/**
 * The note inspector beside the editor: Outline (the live TOC, with the
 * page stats under it) and Backlinks (the pages that link here). The panel
 * passes the backlinks it already fetched for the footer, so the inspector
 * reads nothing itself.
 */
export function KnowledgeInspectorView({
  outline,
  activeHeadingId,
  onJumpToHeading,
  pageStats,
  backlinks,
  onJumpToEntry,
  width = 280,
}: {
  outline: OutlineHeading[];
  activeHeadingId?: string | null;
  onJumpToHeading: (id: string) => void;
  pageStats: Array<[string, string | number]>;
  backlinks: ReadonlyArray<InspectorBacklink>;
  onJumpToEntry: (entryId: string) => void;
  /** Width in px (the panel owns the resizable state). */
  width?: number;
}) {
  const [tab, setTab] = useState<"outline" | "links">("outline");
  const baseId = useId();

  return (
    <aside
      aria-label="Page inspector"
      data-view="knowledge-inspector"
      className="flex min-h-0 shrink-0 flex-col border-l border-border-subtle bg-background"
      style={{ width }}
    >
      {/* A tablist: one Tab stop (the chosen tab); the arrows, Home and End
          move between the two and switch as they go. */}
      <div
        role="tablist"
        aria-label="Inspector"
        className="flex h-[36px] shrink-0 items-center gap-1 border-b border-border-subtle px-2.5"
        onKeyDown={(e) => {
          const at = TABS.findIndex((t) => t.id === tab);
          let next: number | null = null;
          if (e.key === "ArrowRight") next = (at + 1) % TABS.length;
          else if (e.key === "ArrowLeft") next = (at - 1 + TABS.length) % TABS.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = TABS.length - 1;
          if (next === null) return;
          e.preventDefault();
          setTab(TABS[next].id);
          document.getElementById(`${baseId}-tab-${TABS[next].id}`)?.focus();
        }}
      >
        {TABS.map(({ id, label }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              id={`${baseId}-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${baseId}-panel`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(id)}
              className={cn(
                "h-control-sm rounded-full px-3 text-sm leading-none transition-colors duration-fast",
                active
                  ? "bg-foreground font-semibold text-primary-foreground"
                  : "text-muted-foreground hover:text-secondary-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3"
      >
        {tab === "outline" && (
          <>
            <div className="eyebrow mb-2">On this page</div>
            {outline.length === 0 ? (
              <EmptyState icon={ListTree} title="Add H2 or H3 headings to build an outline" />
            ) : (
              outline.map((h, idx) => {
                const isActive = h.id === activeHeadingId;
                return (
                  <button
                    // Compose with index so headings with identical text
                    // (and thus identical slug ids) get unique React keys.
                    key={`${h.id}-${idx}`}
                    type="button"
                    onClick={() => onJumpToHeading(h.id)}
                    aria-current={isActive ? "location" : undefined}
                    className={cn(
                      "block w-full border-l-2 py-1 text-left text-sm transition-colors duration-fast",
                      isActive
                        ? "-ml-2.5 border-foreground pl-2.5 text-foreground"
                        : "border-transparent text-muted-foreground hover:text-secondary-foreground",
                      !isActive && h.level === 3 && "pl-4",
                    )}
                  >
                    {h.label}
                  </button>
                );
              })
            )}

            <div className="mt-6 border-t border-border-subtle pt-3.5">
              <div className="eyebrow mb-2.5">Page stats</div>
              <dl>
                {pageStats.map(([k, v]) => (
                  <div
                    key={k}
                    className="flex justify-between border-b border-border-subtle py-1.5 text-sm text-muted-foreground"
                  >
                    <dt>{k}</dt>
                    <dd className="mono tnum text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}

        {tab === "links" && (
          <>
            <div className="eyebrow mb-2.5">Pages linking here · {backlinks.length}</div>
            {backlinks.length === 0 ? (
              <EmptyState
                icon={Link2}
                title="No backlinks yet. Reference this page from another note with [[note-id]] and it'll show up here."
              />
            ) : (
              <div className="flex flex-col gap-1">
                {backlinks.map((b, idx) => (
                  <button
                    key={`${b.fromEntryId}-${idx}`}
                    type="button"
                    onClick={() => onJumpToEntry(b.fromEntryId)}
                    className="flex w-full gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors duration-fast hover:bg-element-hover focus-visible:bg-element-hover"
                  >
                    <Icon
                      icon={ChevronRight}
                      size="sm"
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">{b.fromTitle}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {b.snippet}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
