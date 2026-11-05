// Which projects the session list shows: the filter at the end of the session
// search row. "All projects", or one of the organisation's projects; the
// choice is remembered across restarts (`sidebar-store.ts`). It filters the
// list only — opening a project is the project picker's (`project-picker.tsx`).
//
// The menu is the picker's list on the popup's own surface — flat, no inset
// card: searchable once the list is long (a search hides "All projects").

import { useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { ArrowDownUp, Boxes, Check, Search } from "lucide-react";

import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { cn } from "@/lib/utils";

import { resolveScopeProjectId, type SidebarProject } from "../lib/sidebar-sessions";
import { useSidebarStore } from "../stores/sidebar-store";
import {
  MENU_EMPTY,
  MENU_ITEM,
  MENU_ITEM_SELECTED,
  MENU_LIST,
  MENU_SEARCH,
  MENU_SEARCH_INPUT,
  MENU_SURFACE,
} from "../lib/menu-surface";
import { filterPickerProjects, SEARCH_THRESHOLD } from "./project-picker";
import { ProjectBadge } from "./session-row-parts";
import { Icon, Hint } from "@tryatlas/design";

export function SessionScopeFilter() {
  const orgProjects = useActiveOrgProjects();
  const projects = useMemo<SidebarProject[]>(
    () => orgProjects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    [orgProjects],
  );
  const scopeProjectId = resolveScopeProjectId(useSidebarStore.use.scopeProjectId(), projects);
  const { setScopeProjectId } = useSidebarStore.use.actions();
  const [query, setQuery] = useState("");
  const scoped = projects.find((project) => project.id === scopeProjectId) ?? null;
  const searchable = projects.length > SEARCH_THRESHOLD;
  const searching = query.trim().length > 0;
  const filtered = filterPickerProjects(projects, query);
  const label = scoped ? `Showing sessions in ${scoped.name}` : "Show sessions from";

  return (
    <DropdownMenu.Root
      onOpenChange={(next) => {
        if (!next) setQuery("");
      }}
    >
      <Hint label={label} side="bottom">
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label={label}
              // The sidebar's round glass control (`GlassIconButton`); on, its
              // fill lifts as a pressed toggle's does, so a filtered list
              // never passes for the whole one.
              aria-pressed={scoped !== null}
              className={cn(
                "glass-rim glass-rim-control flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-fast",
                "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground",
                scoped && "text-foreground",
              )}
            >
              <Icon icon={ArrowDownUp} size="sm" aria-hidden />
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <DropdownMenu.Popup className={MENU_SURFACE}>
            <>
              {searchable ? (
                <div
                  className={MENU_SEARCH}
                  onKeyDown={(event) => {
                    // Keep keys from the menu's typeahead and arrow nav; Escape
                    // still closes it.
                    if (event.key !== "Escape") event.stopPropagation();
                  }}
                >
                  <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects"
                    className={MENU_SEARCH_INPUT}
                  />
                </div>
              ) : null}
              <div className={MENU_LIST}>
                {searching ? null : (
                  <DropdownMenu.Item
                    onClick={() => setScopeProjectId(null)}
                    className={cn(MENU_ITEM, scoped === null && MENU_ITEM_SELECTED)}
                  >
                    <Boxes aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">All projects</span>
                    {scoped === null ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
                  </DropdownMenu.Item>
                )}
                {filtered.length === 0 ? (
                  <div className={MENU_EMPTY}>
                    {projects.length === 0 ? "No projects yet." : "No matching projects."}
                  </div>
                ) : (
                  filtered.map((project) => {
                    const selected = project.id === scopeProjectId;
                    return (
                      <DropdownMenu.Item
                        key={project.id}
                        onClick={() => setScopeProjectId(project.id)}
                        className={cn(MENU_ITEM, selected && MENU_ITEM_SELECTED)}
                      >
                        <ProjectBadge name={project.name} path={project.path} />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        {selected ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
                      </DropdownMenu.Item>
                    );
                  })
                )}
              </div>
            </>
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
