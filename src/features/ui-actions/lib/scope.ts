/**
 * **Project-scoped** (CONTEXT.md): a UI action acts on the active project's
 * view and never switches projects. A tab another project owns is refused,
 * and the refusal names that project so the model can tell the user.
 */

import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { projectIdForTab } from "@/features/chat/lib/tab-project";
import { useAppStore } from "@/features/app/stores/app-store";
import { invoke } from "@tauri-apps/api/core";
import { refuse } from "./args";

/** The tab `tabId` in the active project's view, or a refusal saying why not. */
export function tabInScope(tabId: string): Tab {
  const { tabs, destination } = useLayoutStore.getState();
  const tab = tabs.find((t) => t.id === tabId) ?? (destination?.id === tabId ? destination : null);
  if (tab) return tab;
  const ownerId = projectIdForTab(tabId);
  const owner = ownerId
    ? useProjectStore.getState().projects.find((p) => p.id === ownerId)
    : undefined;
  if (owner) {
    return refuse(
      `tab ${tabId} belongs to project "${owner.name}", not the active one; UI actions never switch projects — ask the user to switch`,
    );
  }
  return refuse(`no tab ${tabId} in the active project; ui_state lists the open tabs`);
}

/** The active project, or a refusal when none is open. */
export function activeProject(): { name: string; path: string } {
  return useAppStore.getState().currentProject ?? refuse("no project is open in Atlas");
}

const join = (base: string, rel: string) =>
  `${base.replace(/\/$/, "")}/${rel.replace(/^\.\//, "")}`;

/** `path` made absolute. A relative path resolves against the calling
 *  session's working directory when that is inside the active project and
 *  the path exists there, else against the project root. */
export async function resolvePath(path: string, cwd: string): Promise<string> {
  // A network path (`//host/share`, `\\host\share`, `\\?\UNC\…`) is refused
  // before anything touches it: on Windows merely reading one opens an SMB
  // connection, which hands the user's NTLM credentials to that host.
  if (/^[\\/]{2}/.test(path)) {
    return refuse(`${path} is a network path; UI actions open files on this machine only`);
  }
  if (path.startsWith("/")) return path;
  const project = activeProject().path;
  const cwdInProject = cwd !== project && cwd.startsWith(`${project}/`);
  if (cwdInProject) {
    const underCwd = join(cwd, path);
    const exists = await invoke("file_mtime_ms", { path: underCwd }).then(
      () => true,
      () => false,
    );
    if (exists) return underCwd;
  }
  return join(project, path);
}
