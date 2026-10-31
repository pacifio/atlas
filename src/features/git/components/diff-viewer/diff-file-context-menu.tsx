import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/ui/context-menu";
import { OpenInEditorContextItems } from "@/features/external-editor/components/open-in-editor-menu";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import { openInEditor } from "@/features/external-editor/lib/preferred-editor";
import { revealProject } from "@/features/session-context/lib/workspace-actions";
import { diffFileMenuItems, type DiffFileMenuTarget } from "../../lib/diff-file-menu";

const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

/**
 * The menu a diff file header's right-click opens (`diffFileMenuItems` says
 * what is in it). Rendered inside the panel's `ContextMenu`, only once a
 * header was the target.
 */
export function DiffFileContextMenuContent({
  target,
  onOpen,
}: {
  target: DiffFileMenuTarget;
  /** "Open": the file in Atlas, as a click on the header's name opens it. */
  onOpen: () => void;
}) {
  const items = diffFileMenuItems(target);
  const abs = target.absPath;
  return (
    <ContextMenuContent>
      {items.map((item, index) => {
        switch (item) {
          case "separator":
            return <ContextMenuSeparator key={`separator-${index}`} />;
          case "open":
            return (
              <ContextMenuItem key={item} onClick={onOpen}>
                Open
              </ContextMenuItem>
            );
          case "reveal":
            return abs ? (
              <ContextMenuItem key={item} onClick={() => void revealProject(abs)}>
                Reveal in Finder
              </ContextMenuItem>
            ) : null;
          case "open-default":
            return abs ? (
              <ContextMenuItem key={item} onClick={() => void openInEditor(SYSTEM_EDITOR_ID, abs)}>
                Open in Default App
              </ContextMenuItem>
            ) : null;
          case "open-in-editor":
            return abs ? <OpenInEditorContextItems key={item} path={abs} /> : null;
          case "copy-path":
            return abs ? (
              <ContextMenuItem key={item} onClick={() => copyText(abs)}>
                Copy Path
              </ContextMenuItem>
            ) : null;
          case "copy-relative-path":
            return (
              <ContextMenuItem key={item} onClick={() => copyText(target.relPath)}>
                Copy Relative Path
              </ContextMenuItem>
            );
        }
      })}
    </ContextMenuContent>
  );
}
