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

import { useMemo, useState } from "react";
import { openPullRequestListTab } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  GitPullRequest,
  Boxes,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/ui/icon";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useCommandPaletteStore } from "@/features/command-palette/stores/command-palette-store";
import {
  ORG_MENU_POPUP_CLASS,
  OrgAvatar,
  useOrgMenu,
} from "@/features/organisations/components/org-switcher";
import { ImportThreadsModal } from "@/features/chat/components/import-threads-modal";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { resolveScopeProjectId, type SidebarProject } from "../lib/sidebar-sessions";
import { openProjectSettings } from "../lib/sidebar-actions";
import { useSidebarStore } from "../stores/sidebar-store";
import { ProjectBadge } from "./session-row-parts";
import { GlassIconButton } from "./glass-icon-button";

/** Past this many projects the menu grows a search field. */
const SEARCH_THRESHOLD = 6;

// The organisation menu's recipe (`ORG_MENU_POPUP_CLASS`), so the two menus
// that open side by side read as one: the choices (scope, projects) are inset
// chips in a card on the app's background; the actions sit on the tinted
// surround below it.
const LIST_ITEM =
  "mx-1 flex h-control-md w-[calc(100%-8px)] cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm outline-none transition-colors hover:bg-foreground/6 hover:text-foreground data-highlighted:bg-foreground/6 data-highlighted:text-foreground";
const LIST_ITEM_SELECTED = "bg-foreground/8 text-foreground";
const ACTION =
  "flex h-control-md w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-element-hover hover:text-foreground data-highlighted:bg-element-hover data-highlighted:text-foreground data-popup-open:bg-element-hover";

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

/** The picker wired to the stores: the active organisation's projects, the
 *  remembered scope, and the session import it opens. */
export function SidebarProjectPicker() {
  const orgProjects = useActiveOrgProjects();
  const projects = useMemo<SidebarProject[]>(
    () => orgProjects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    [orgProjects],
  );
  const scopeProjectId = resolveScopeProjectId(useSidebarStore.use.scopeProjectId(), projects);
  const { setScopeProjectId } = useSidebarStore.use.actions();
  const [importOpen, setImportOpen] = useState(false);
  return (
    <>
      <ProjectPicker
        projects={projects}
        scopeProjectId={scopeProjectId}
        onScopeChange={setScopeProjectId}
        onProjectSettings={(project) => openProjectSettings(project.path)}
        onImportSessions={() => setImportOpen(true)}
      />
      <ImportThreadsModal open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
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
  const addProjectHint = useActionShortcut("workspace.add")?.label;
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
    <div className="flex w-full shrink-0 items-center">
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
              // The destinations' row (`DestinationButton`): the same height,
              // inset and icon-to-label gap, so the badge sits in their icon
              // column.
              className="flex h-7 min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm leading-none font-medium text-foreground outline-none transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-element-hover"
            />
          }
        >
          {/* A 14px box, the destinations' icon (`Icon` md, in pixels). */}
          <span className="flex size-[14px] shrink-0 items-center justify-center">
            {scoped ? (
              <ProjectBadge
                name={scoped.name}
                path={scoped.path}
                className="size-[14px] text-3xs"
              />
            ) : (
              <Icon icon={Boxes} size="md" aria-hidden className="shrink-0 text-muted-foreground" />
            )}
          </span>
          <span className="min-w-0 truncate text-left">{label}</span>
          <ChevronDown aria-hidden className="-ml-1 size-3 shrink-0 text-muted-foreground" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Positioner className="z-popover" side="bottom" align="start" sideOffset={4}>
            <DropdownMenu.Popup className={ORG_MENU_POPUP_CLASS}>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-background shadow-sm ring-1 ring-border">
                {searchable ? (
                  <div
                    className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-foreground/8 px-2.5"
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

                <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                  {searching ? null : (
                    <DropdownMenu.Item
                      onClick={() => onScopeChange(null)}
                      className={cn(LIST_ITEM, scoped === null && LIST_ITEM_SELECTED)}
                    >
                      <Boxes aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
                          className={cn(
                            LIST_ITEM,
                            "group/scope-item",
                            selected && LIST_ITEM_SELECTED,
                          )}
                        >
                          <ProjectBadge name={project.name} path={project.path} />
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
              </div>

              <div className="mt-1.5 shrink-0">
                <DropdownMenu.Item
                  onClick={() => useCommandPaletteStore.getState().actions.openAddProject()}
                  className={ACTION}
                >
                  <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Add project</span>
                </DropdownMenu.Item>
                {scoped ? (
                  <DropdownMenu.Item onClick={() => onProjectSettings(scoped)} className={ACTION}>
                    <Settings aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{scoped.name} settings</span>
                  </DropdownMenu.Item>
                ) : null}
                {scoped ? (
                  <DropdownMenu.Item
                    onClick={() =>
                      openPullRequestListTab({ repoPath: scoped.path, name: scoped.name })
                    }
                    className={ACTION}
                  >
                    <GitPullRequest
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{scoped.name} pull requests</span>
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item onClick={onImportSessions} className={ACTION}>
                  <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">Import sessions from agents…</span>
                </DropdownMenu.Item>
              </div>

              {org.active ? (
                <div className="shrink-0">
                  <DropdownMenu.Separator className="mx-1.5 my-1 h-px shrink-0 bg-border-subtle" />
                  <DropdownMenu.SubmenuRoot>
                    <DropdownMenu.SubmenuTrigger
                      className={ACTION}
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

      <GlassIconButton
        icon={Plus}
        label="Add project"
        shortcut={addProjectHint}
        onClick={() => useCommandPaletteStore.getState().actions.openAddProject()}
        className="ml-auto"
      />
      {org.dialogs}
    </div>
  );
}
