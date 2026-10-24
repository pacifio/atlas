// The sidebar's top control: which projects the session list shows. "All
// projects", or one, named with its badge; the choice is remembered across
// restarts (`sidebar-store.ts`).
//
// Its menu is the project scope — "All projects", then the organisation's
// projects, searchable once the list is long (a search hides "All projects",
// and a right click or the gear on a project opens its settings) — then Add
// project, the chosen project's settings and the session import. At its foot
// sits the organisation: a submenu holding the organisation menu itself
// (switching, with locked organisations explained; create; members, with why
// they are unavailable; the id; sync), the same menu the title bar's
// breadcrumb opens.

import { useState } from "react";
import { openPullRequestListTab } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  GitPullRequest,
  Layers,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import {
  ADD_PROJECT_POPUP_CLASS,
  AddProjectItems,
} from "@/features/projects/components/add-project-menu";
import {
  ORG_MENU_POPUP_CLASS,
  OrgAvatar,
  useOrgMenu,
} from "@/features/organisations/components/org-switcher";
import type { SidebarProject } from "../lib/sidebar-sessions";
import { ProjectBadge } from "./session-row-parts";

/** Past this many projects the menu grows a search field. */
const SEARCH_THRESHOLD = 6;

const ITEM =
  "flex h-control-md w-full cursor-pointer items-center gap-2 rounded px-2 text-xs text-secondary-foreground outline-none data-highlighted:bg-element-hover data-highlighted:text-foreground data-popup-open:bg-element-hover";

/** The projects a query keeps: by name, case-insensitively. Every project for
 *  an empty query. */
export function filterPickerProjects(
  projects: readonly SidebarProject[],
  query: string,
): readonly SidebarProject[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((project) => project.name.toLowerCase().includes(needle));
}

export function ProjectPicker({
  projects,
  scopeProjectId,
  onScopeChange,
  onProjectSettings,
  onImportSessions,
}: {
  projects: readonly SidebarProject[];
  scopeProjectId: string | null;
  onScopeChange: (projectId: string | null) => void;
  onProjectSettings: (project: SidebarProject) => void;
  onImportSessions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const org = useOrgMenu();
  const paletteHint = useActionShortcut("nav.commandPalette")?.label;
  const scoped = projects.find((project) => project.id === scopeProjectId) ?? null;
  const searchable = projects.length > SEARCH_THRESHOLD;
  const searching = query.trim().length > 0;
  const filtered = filterPickerProjects(projects, query);
  const close = () => setOpen(false);
  const openSettings = (project: SidebarProject) => {
    close();
    onProjectSettings(project);
  };
  const label = scoped?.name ?? "All projects";

  return (
    <div className="flex h-8 shrink-0 items-center px-2">
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            org.reset();
          }
        }}
      >
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label={`Sessions in: ${label}`}
              className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          {scoped ? (
            <ProjectBadge name={scoped.name} />
          ) : (
            <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate text-left">{label}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
            <DropdownMenu.Popup className="flex max-h-[min(480px,70vh)] w-64 flex-col overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-md outline-none origin-[var(--transform-origin)] animate-scale-in">
              {searchable ? (
                <div
                  className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border px-2.5"
                  onKeyDown={(event) => {
                    // Keep keys from the popup's typeahead and arrow nav, but let
                    // Escape bubble to the dismiss handler so it still closes.
                    if (event.key !== "Escape") event.stopPropagation();
                  }}
                >
                  <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects"
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
              ) : null}

              <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-0.5">
                {searching ? null : (
                  <DropdownMenu.Item
                    onClick={() => onScopeChange(null)}
                    className={cn(ITEM, scoped === null && "text-foreground")}
                  >
                    <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">All projects</span>
                    {scoped === null ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
                  </DropdownMenu.Item>
                )}
                {filtered.length === 0 ? (
                  <div className="px-2 py-2 text-center text-2xs text-muted-foreground">
                    {projects.length === 0 ? "No projects yet." : "No matching projects."}
                  </div>
                ) : (
                  filtered.map((project) => {
                    const selected = project.id === scopeProjectId;
                    return (
                      <DropdownMenu.Item
                        key={project.id}
                        onClick={() => onScopeChange(project.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          openSettings(project);
                        }}
                        className={cn(ITEM, "group/scope-item", selected && "text-foreground")}
                      >
                        <ProjectBadge name={project.name} />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Project settings for ${project.name}`}
                          title={`Project settings for ${project.name}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            openSettings(project);
                          }}
                          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:text-foreground group-hover/scope-item:opacity-100 group-data-highlighted/scope-item:opacity-100"
                        >
                          <Settings aria-hidden className="size-3.5" />
                        </button>
                        {selected ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
                      </DropdownMenu.Item>
                    );
                  })
                )}
              </div>

              <div className="shrink-0 border-t border-border p-0.5">
                <DropdownMenu.SubmenuRoot>
                  <DropdownMenu.SubmenuTrigger className={ITEM}>
                    <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">Add project</span>
                    <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  </DropdownMenu.SubmenuTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Positioner
                      className="z-popover"
                      side="right"
                      align="start"
                      alignOffset={-3}
                    >
                      <DropdownMenu.Popup className={ADD_PROJECT_POPUP_CLASS}>
                        <AddProjectItems />
                      </DropdownMenu.Popup>
                    </DropdownMenu.Positioner>
                  </DropdownMenu.Portal>
                </DropdownMenu.SubmenuRoot>
                {scoped ? (
                  <DropdownMenu.Item onClick={() => onProjectSettings(scoped)} className={ITEM}>
                    <Settings aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{scoped.name} settings</span>
                  </DropdownMenu.Item>
                ) : null}
                {scoped ? (
                  <DropdownMenu.Item
                    onClick={() =>
                      openPullRequestListTab({ repoPath: scoped.path, name: scoped.name })
                    }
                    className={ITEM}
                  >
                    <GitPullRequest
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{scoped.name} pull requests</span>
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item onClick={onImportSessions} className={ITEM}>
                  <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Import sessions from agents…</span>
                </DropdownMenu.Item>
              </div>

              {org.active ? (
                <div className="shrink-0 border-t border-border p-0.5">
                  <DropdownMenu.SubmenuRoot>
                    <DropdownMenu.SubmenuTrigger
                      className={ITEM}
                      aria-label={`Organization: ${org.active.name}`}
                    >
                      <OrgAvatar org={org.active} size={16} plain />
                      <span className="min-w-0 flex-1 truncate">{org.active.name}</span>
                      <span className="shrink-0 text-2xs text-muted-foreground">Organization</span>
                      <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                    </DropdownMenu.SubmenuTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Positioner
                        className="z-popover"
                        side="right"
                        align="end"
                        alignOffset={-6}
                      >
                        <DropdownMenu.Popup className={ORG_MENU_POPUP_CLASS}>
                          {org.panel(close)}
                        </DropdownMenu.Popup>
                      </DropdownMenu.Positioner>
                    </DropdownMenu.Portal>
                  </DropdownMenu.SubmenuRoot>
                </div>
              ) : null}
            </DropdownMenu.Popup>
          </DropdownMenu.Positioner>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Search everything: the command palette. */}
      <div className="ml-auto flex shrink-0 items-center">
        <Hint label="Search" shortcut={paletteHint}>
          <button
            type="button"
            aria-label="Search"
            onClick={() => window.dispatchEvent(new CustomEvent("atlas:command-palette"))}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-element-hover hover:text-foreground"
          >
            <Search aria-hidden className="size-3.5" />
          </button>
        </Hint>
      </div>
      {org.dialogs}
    </div>
  );
}
