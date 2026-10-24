import { activeProjectId } from "@/features/projects/lib/active-project";
import { fileKindOf, openFileAs, type OpenFileOptions } from "@/lib/open-file";

/**
 * Open `abs` as a tab of the project that is active now, then call
 * `onOpened`, unless the user has switched project by the time the file's
 * kind is known.
 *
 * Classifying a file can wait on the backend (a name with no known
 * extension, `Makefile`, is sniffed for text). The layout store holds the
 * ACTIVE project's tabs, so a tab opened after a switch would land in the
 * other project, and an `onOpened` that closes a tab by id (the Files
 * surface's `"files"`, the same id in every project) would close that
 * project's tab instead. A click in one project acts in that project or not
 * at all.
 *
 * `opts.reveal` puts the cursor on a line once the file is open (a session's
 * `path:line` chip).
 */
export async function openInProject(
  abs: string,
  onOpened?: (abs: string) => void,
  opts?: OpenFileOptions,
): Promise<void> {
  const project = activeProjectId();
  const kind = await fileKindOf(abs);
  if (activeProjectId() !== project) return;
  if (opts) openFileAs(abs, kind, opts);
  else openFileAs(abs, kind);
  onOpened?.(abs);
}
