/**
 * The workspace rail's "+" — Open Folder plus a searchable list of recent
 * projects, adding the chosen one to the sidebar.
 *
 * Its own file because two surfaces render it: the rail's org row (its home,
 * beside the ⌘K search button) and, historically, the titlebar band. Keeping
 * it in `workspace-sidebar.tsx` would have made `org-switcher.tsx` import from
 * the very module that renders `<OrgSwitcher/>` — a cycle.
 */
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Folder, FolderOpen, Plus, Search, Trash2 } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { pickAndAddWorkspace } from "../lib/pick-workspace";

export function AddProjectMenu() {
  const { addWorkspace } = useWorkspaceStore.use.actions();
  const recentProjects = useProjectStore.use.recentProjects();
  const { clearRecents } = useProjectStore.use.actions();
  const [query, setQuery] = useState("");
  const filtered = recentProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <DropdownMenu.Root
      onOpenChange={(o) => {
        if (!o) setQuery("");
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className="flex size-6 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors cursor-pointer"
          title="Add project"
          aria-label="Add project"
        >
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Compact menu primitive — mirrors the source-control "filter files"
         *  dropdown: 26px rows, px-3 on both sides, border-b search header. */}
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[var(--z-max)] w-[280px] max-h-[360px] rounded-lg border border-[var(--border-default)] bg-[#000] shadow-xl text-[var(--text-secondary)] flex flex-col overflow-hidden"
        >
          <DropdownMenu.Item
            onSelect={() => void pickAndAddWorkspace()}
            className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default shrink-0"
          >
            <FolderOpen size={13} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="flex-1 text-left">Open Folder…</span>
          </DropdownMenu.Item>
          {recentProjects.length > 0 && (
            <>
              <div
                className="flex items-center gap-1.5 px-3 h-[30px] border-y border-[var(--border-default)] shrink-0"
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects…"
                  className="flex-1 bg-transparent outline-none text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
              </div>
              <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-[var(--text-tertiary)] shrink-0">
                Recent
              </div>
              <div className="overflow-y-auto py-1 hide-scrollbar">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] text-center">
                    No matches
                  </div>
                ) : (
                  filtered.map((p) => (
                    <DropdownMenu.Item
                      key={p.path}
                      onSelect={() => void addWorkspace(p.path)}
                      className="w-full flex items-center gap-2 px-3 h-[26px] text-[11px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
                    >
                      <Folder size={12} className="text-[var(--text-tertiary)] shrink-0" />
                      <span className="truncate font-mono text-left flex-1">{p.name}</span>
                    </DropdownMenu.Item>
                  ))
                )}
              </div>
              <DropdownMenu.Item
                onSelect={() => clearRecents()}
                className="w-full flex items-center gap-2 px-3 h-[28px] text-[11px] outline-none border-t border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--status-error,#f44)] cursor-pointer shrink-0"
              >
                <Trash2 size={12} className="shrink-0" />
                <span className="flex-1 text-left">Clear recent projects</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
