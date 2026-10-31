// Where the session runs, how to open it, and the project's scripts: the
// Workspace group, three rows with no heading.
//
//  - Environment: a machine glyph and a folder glyph, then the machine's
//    name (`m4-pro`). Every Atlas session runs on this machine, in its
//    project's checkout or a pull request's worktree, so the row states that
//    rather than offering a choice. Right-click copies the path.
//  - Open in: "Open in <editor>" opens where the session works; the ⌄ picks
//    which editor that is (it sets Settings ▸ Preferred editor, and opens
//    nothing). The file manager is one of the choices. ⌘O does the same as
//    the main button.
//  - Project scripts (`ProjectScriptsRow`).

import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FolderOpen, Laptop } from "lucide-react";

import { EditorIcon } from "@/features/external-editor/components/editor-icons";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import {
  openInEditor,
  openInLabel,
  usePreferredEditor,
} from "@/features/external-editor/lib/preferred-editor";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isMac, isWindows } from "@/lib/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { DropdownMenuItem, DropdownMenuShortcut } from "@/ui/dropdown-menu";

import { sessionEnvironment } from "../lib/session-context-api";
import { copyProjectPath, revealProject } from "../lib/workspace-actions";
import { DetailsRow, DetailsSection, DetailsSplit, RowIcon, RowLabel } from "./details-rows";
import { ProjectScriptsRow } from "./project-scripts-row";

export const FILE_MANAGER = isMac ? "Finder" : isWindows ? "Explorer" : "File Manager";

function useSessionEnvironment() {
  return useQuery({
    queryKey: ["session-context", "environment"],
    queryFn: sessionEnvironment,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

export function WorkspaceSection({
  projectPath,
  workPath,
  showEnvironment,
  showOpenIn,
}: {
  projectPath: string;
  /** Where the session works (`sessionWorkPath`): what opens, where scripts run. */
  workPath: string;
  showEnvironment: boolean;
  showOpenIn: boolean;
}) {
  return (
    <DetailsSection label="Workspace">
      {showEnvironment && <EnvironmentRow projectPath={projectPath} workPath={workPath} />}
      {showOpenIn && <OpenInRow path={workPath} />}
      <ProjectScriptsRow projectPath={projectPath} cwd={workPath} />
    </DetailsSection>
  );
}

function EnvironmentRow({ projectPath, workPath }: { projectPath: string; workPath: string }) {
  const environment = useSessionEnvironment();
  const worktree = workPath !== projectPath;
  const where = worktree ? "Worktree" : "Project checkout";
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>
        <DetailsRow title={`${environment?.name || "This device"} · ${where}\n${workPath}`}>
          {/* One glyph: the device. Checkout vs worktree is in the tooltip. */}
          <RowIcon icon={Laptop} />
          <RowLabel>{environment?.name || "This device"}</RowLabel>
        </DetailsRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => void copyProjectPath(workPath)}>
          <Copy />
          Copy full path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Open `path` where the preferred editor says: an editor, or the file
 *  manager when that is the preference (or nothing is detected). */
export function openWithPreference(editorId: string | null, path: string): Promise<void> {
  return editorId && editorId !== SYSTEM_EDITOR_ID
    ? openInEditor(editorId, path)
    : revealProject(path);
}

function OpenInRow({ path }: { path: string }) {
  const { editors, preferred } = usePreferredEditor();
  const shortcut = useActionShortcut("app.openInEditor");
  const editor = preferred && preferred.id !== SYSTEM_EDITOR_ID ? preferred : null;
  const choices = (editors ?? []).filter((e) => e.id !== SYSTEM_EDITOR_ID);
  const choose = (id: string) =>
    useSettingsStore.getState().actions.updateSettings({ preferredEditor: id });
  const current = editor?.id ?? SYSTEM_EDITOR_ID;

  return (
    <DetailsSplit
      onClick={() => void openWithPreference(editor?.id ?? null, path)}
      title={path}
      menuLabel="Choose an editor"
      menu={
        <>
          {choices.map((e) => (
            <DropdownMenuItem key={e.id} onClick={() => choose(e.id)}>
              <EditorIcon id={e.id} />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {e.id === current && <Check aria-label="Preferred" />}
              {e.id === current && shortcut && (
                <DropdownMenuShortcut>{shortcut.label}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => choose(SYSTEM_EDITOR_ID)}>
            <FolderOpen />
            <span className="min-w-0 flex-1 truncate">{FILE_MANAGER}</span>
            {current === SYSTEM_EDITOR_ID && <Check aria-label="Preferred" />}
            {current === SYSTEM_EDITOR_ID && shortcut && (
              <DropdownMenuShortcut>{shortcut.label}</DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        </>
      }
    >
      {editor ? <EditorIcon id={editor.id} /> : <RowIcon icon={FolderOpen} />}
      <RowLabel>{editor ? openInLabel(editor) : `Open in ${FILE_MANAGER}`}</RowLabel>
    </DetailsSplit>
  );
}
