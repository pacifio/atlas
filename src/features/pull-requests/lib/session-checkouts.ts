// The checkouts a session's pull request can be read in, nearest first: the
// session's own folders, the projects attached to it, the open project, then
// every other project Atlas knows. A link names its own repository (an agent
// may link any pull request), and the `pr_*` commands read by number in a
// checkout, so a link opens, links or acts in the first of these that is its
// repository (`findCheckoutFor`), and on the host when none is.
//
// Read at the moment of acting (`getState`), never subscribed: the list only
// matters when someone clicks.

import type { ThreadRow } from "@/features/chat/lib/history-api";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";

export function sessionCheckouts(
  row: Pick<ThreadRow, "folderPaths" | "attachedProjects"> | null | undefined,
  first?: string | null,
): string[] {
  const paths = [
    ...(first ? [first] : []),
    ...(row?.folderPaths ?? []),
    ...(row?.attachedProjects.map((project) => project.path) ?? []),
  ];
  const current = useAppStore.getState().currentProject?.path;
  if (current) paths.push(current);
  for (const project of useProjectStore.getState().projects) paths.push(project.path);
  return [...new Set(paths.filter(Boolean))];
}
