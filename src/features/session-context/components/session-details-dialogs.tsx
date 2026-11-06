// The dialogs the Details card opens: a project script's editor, its
// first-run confirmation, the Commit row's commit and default-branch
// questions, and Create PR. Mounted once, at the app root, not
// in the card: the popover form closes as focus moves into a dialog, and a
// dialog mounted inside it would close with it. One mount, too, where a
// mount per session header (or per mounted project) would open one copy each.

import { CreatePrDialogHost } from "./create-pr-dialog";
import { GitActionDialogHost } from "./git-action-dialogs";
import { ProjectScriptConfirmHost } from "./project-script-confirm";
import { ProjectScriptDialogHost } from "./project-script-dialog";

export function SessionDetailsDialogs() {
  return (
    <>
      <ProjectScriptDialogHost />
      <ProjectScriptConfirmHost />
      <GitActionDialogHost />
      <CreatePrDialogHost />
    </>
  );
}
