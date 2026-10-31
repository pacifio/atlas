// "Open in <editor>" as menu items: the preferred editor first, then the rest
// of what is installed. One component per menu primitive, since a context
// menu and a dropdown are different Base UI trees.

import { AppWindow, SquareArrowOutUpRight } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu";
import {
  SYSTEM_EDITOR_ID,
  type EditorPosition,
  type ExternalEditor,
} from "../lib/external-editor-api";
import { openInEditor, openInLabel, usePreferredEditor } from "../lib/preferred-editor";

/** The preferred editor, and every other installed one (the system default
 *  among them), in detection order. Empty until detection answers. */
export function editorMenuEntries(
  editors: readonly ExternalEditor[] | null,
  preferred: ExternalEditor | null,
): { primary: ExternalEditor | null; others: ExternalEditor[] } {
  if (!editors || !preferred) return { primary: null, others: [] };
  return { primary: preferred, others: editors.filter((e) => e.id !== preferred.id) };
}

/** For a context menu: "Open in Cursor", then an "Open With" submenu.
 *  `withIcons` gives both a leading icon, for a menu whose other items have
 *  one — without it their labels sit left of everyone else's. */
export function OpenInEditorContextItems({
  path,
  position,
  withIcons = false,
}: {
  path: string;
  position?: EditorPosition;
  withIcons?: boolean;
}) {
  const { editors, preferred } = usePreferredEditor();
  const { primary, others } = editorMenuEntries(editors, preferred);
  if (!primary) return null;
  return (
    <>
      <ContextMenuItem onClick={() => void openInEditor(primary.id, path, position)}>
        {withIcons && <SquareArrowOutUpRight />}
        {openInLabel(primary)}
      </ContextMenuItem>
      {others.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {withIcons && <AppWindow />}
            Open With
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {others.map((editor) => (
              <ContextMenuItem
                key={editor.id}
                onClick={() => void openInEditor(editor.id, path, position)}
              >
                {editor.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </>
  );
}

/** For a dropdown: one "Open in X" item per installed editor, preferred
 *  first; the system default is left to the caller, which has its own
 *  file-manager wording for a folder. */
export function OpenInEditorDropdownItems({
  path,
  separatorAfter = false,
}: {
  path: string;
  /** Close the group with a separator, drawn only when there are items. */
  separatorAfter?: boolean;
}) {
  const { editors, preferred } = usePreferredEditor();
  const { primary, others } = editorMenuEntries(editors, preferred);
  if (!primary) return null;
  const items = [primary, ...others].filter((e) => e.id !== SYSTEM_EDITOR_ID);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((editor) => (
        <DropdownMenuItem key={editor.id} onClick={() => void openInEditor(editor.id, path)}>
          <SquareArrowOutUpRight />
          {openInLabel(editor)}
        </DropdownMenuItem>
      ))}
      {separatorAfter && <DropdownMenuSeparator />}
    </>
  );
}
