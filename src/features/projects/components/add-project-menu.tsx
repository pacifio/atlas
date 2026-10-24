/**
 * "Add project" as menu items — Open Folder plus a searchable list of recent
 * projects, adding the chosen one to the organisation.
 *
 * It lives with the projects feature, not the sidebar, because it is a
 * project action: the sidebar's project picker (`project-picker.tsx`) only
 * hosts it, as a submenu. The items render inside whatever menu popup holds
 * them; `ADD_PROJECT_POPUP_CLASS` is the popup they were drawn for.
 */
import { useMemo, useState } from "react";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Folder, FolderOpen, Search, Trash2 } from "lucide-react";
import { useAppStore } from "@/features/app/stores/app-store";
import { recentsForOrg } from "@/features/app/lib/recent-projects";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "../stores/project-store";
import { pickAndAddProject } from "../lib/pick-project";

/** Compact menu surface — mirrors the source-control "filter files" dropdown:
 *  26px rows, px-3 on both sides, a border-b search header. */
export const ADD_PROJECT_POPUP_CLASS =
  "w-[280px] max-h-[360px] rounded-lg border border-[var(--border)] bg-popover shadow-xl text-[var(--secondary-foreground)] flex flex-col overflow-hidden";

export function AddProjectItems() {
  const { addProject } = useProjectStore.use.actions();
  const allRecents = useAppStore.use.recentProjects();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const projects = useProjectStore.use.projects();
  // Scoped to the active org — see `recentsForOrg`.
  const recentProjects = useMemo(
    () => recentsForOrg(allRecents, projects, activeOrgId),
    [allRecents, projects, activeOrgId],
  );
  const { clearRecents } = useAppStore.use.actions();
  const [query, setQuery] = useState("");
  const filtered = recentProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <DropdownMenu.Item
        onClick={() => void pickAndAddProject()}
        className="w-full flex items-center gap-2 px-3 h-[28px] text-xs outline-none hover:bg-[var(--atlas-element-hover)] data-highlighted:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default shrink-0"
      >
        <FolderOpen size={13} className="text-[var(--muted-foreground)] shrink-0" />
        <span className="flex-1 text-left">Open Folder…</span>
      </DropdownMenu.Item>
      {recentProjects.length > 0 && (
        <>
          <div
            className="flex items-center gap-1.5 px-3 h-[30px] border-y border-[var(--border)] shrink-0"
            onKeyDown={(e) => {
              // Keep keys from the popup's typeahead and arrow nav, but let Escape
              // bubble to the dismiss handler so it still closes the popup.
              if (e.key !== "Escape") e.stopPropagation();
            }}
          >
            <Search size={11} className="text-[var(--muted-foreground)] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search recent projects"
              className="flex-1 bg-transparent outline-none text-2xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="px-3 pt-1.5 pb-0.5 text-3xs uppercase tracking-wide text-[var(--muted-foreground)] shrink-0">
            Recent
          </div>
          <div className="overflow-y-auto py-1 hide-scrollbar">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-2xs text-[var(--muted-foreground)] text-center">
                No matches
              </div>
            ) : (
              filtered.map((p) => (
                <DropdownMenu.Item
                  key={p.path}
                  onClick={() => void addProject(p.path)}
                  className="w-full flex items-center gap-2 px-3 h-control-md text-xs outline-none hover:bg-[var(--atlas-element-hover)] data-highlighted:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-default"
                >
                  <Folder size={12} className="text-[var(--muted-foreground)] shrink-0" />
                  <span className="truncate font-mono text-left flex-1">{p.name}</span>
                </DropdownMenu.Item>
              ))
            )}
          </div>
          <DropdownMenu.Item
            onClick={() => clearRecents()}
            className="w-full flex items-center gap-2 px-3 h-[28px] text-xs outline-none border-t border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] data-highlighted:bg-[var(--atlas-element-hover)] hover:text-error cursor-pointer shrink-0"
          >
            <Trash2 size={12} className="shrink-0" />
            <span className="flex-1 text-left">Clear recent projects</span>
          </DropdownMenu.Item>
        </>
      )}
    </>
  );
}
