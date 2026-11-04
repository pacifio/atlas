// Git status for a terminal's working directory.
//
// Two readers want the same answer at the same moment: the focused terminal's
// footer badge, and its row in the pane's side list. Both re-ask when the
// directory changes or a command finishes, so without sharing every command
// end ran `git status` twice for the visible terminal. Calls for one directory
// that overlap share one invoke; nothing is cached past it, because a command
// that just finished may have changed the answer.

import { gitStatusFresh } from "./terminal-api";

/** Compact git status for a terminal's directory. */
export interface TermGit {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

const inFlight = new Map<string, Promise<TermGit | null>>();

/** `null` outside a repository, and when git itself fails. */
export function fetchTermGit(cwd: string): Promise<TermGit | null> {
  const pending = inFlight.get(cwd);
  if (pending) return pending;
  const p = gitStatusFresh(cwd)
    .then((s) =>
      s.is_repo
        ? { branch: s.branch, ahead: s.ahead, behind: s.behind, dirty: s.files.length > 0 }
        : null,
    )
    .catch(() => null)
    .finally(() => inFlight.delete(cwd));
  inFlight.set(cwd, p);
  return p;
}
