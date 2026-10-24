// The overlay's git verbs, run the way Source Control's toolbar runs them.
//
// Every one goes through the git store (which owns the IPC) and reports the
// same way the panel does: a notification for the remote op, and
// `handleGitError` for a failure. Two of `handleGitError`'s outcomes are
// dialogs that only Source Control mounts (the error dialog, the diverged-pull
// choice), so when one is raised the panel is brought into view to show it —
// otherwise the failure would sit in the store with nothing on screen.

import { handleGitError } from "@/features/git/lib/git-errors";
import { openGitPanel } from "@/features/git/lib/open-git-panel";
import { useGitStore } from "@/features/git/stores/git-store";
import { gitErrorText, notifyGitRemoteOp } from "@/features/notifications/lib/outcome-notifier";
import { activeProjectId } from "@/features/projects/lib/active-project";

type RemoteOp = "fetch" | "pull" | "push" | "publish";

/** Bring Source Control into view on its changes (the commit box). */
export function revealSourceControl(): void {
  const id = activeProjectId();
  if (id) void openGitPanel(id);
}

/** Run a remote op and report it. Resolves whether it succeeded, so a flow
 *  that needs the branch on the remote (Create PR) can stop on a failure. */
async function runRemote(label: RemoteOp, fn: () => Promise<void>): Promise<boolean> {
  const path = useGitStore.getState().repoPath;
  const startedAt = Date.now();
  try {
    await fn();
    notifyGitRemoteOp(label, path, startedAt, null);
    return true;
  } catch (e) {
    notifyGitRemoteOp(label, path, startedAt, gitErrorText(e));
    handleGitError(e);
    const { errorDialog, pullChoice } = useGitStore.getState();
    if (errorDialog || pullChoice) revealSourceControl();
    return false;
  }
}

export function pushBranch(): Promise<boolean> {
  return runRemote("push", () => useGitStore.getState().actions.push());
}

export function publishBranch(): Promise<boolean> {
  return runRemote("publish", () => useGitStore.getState().actions.publishBranch());
}

export function fetchRemotes(): Promise<boolean> {
  return runRemote("fetch", () => useGitStore.getState().actions.fetch());
}

/** Pull, asking first on a diverged branch exactly as Source Control does:
 *  a plain pull reconciles only when git config names a strategy. */
export async function pullBranch(): Promise<void> {
  const { ahead, behind, actions } = useGitStore.getState();
  if (ahead > 0 && behind > 0) {
    const preference = await actions.pullPreference().catch(() => "ask" as const);
    if (preference === "ask") {
      actions.showPullChoice({ kind: "diverged" });
      revealSourceControl();
      return;
    }
  }
  await runRemote("pull", () => actions.pull());
}

export async function checkoutBranch(branch: string): Promise<void> {
  try {
    await useGitStore.getState().actions.checkout(branch);
  } catch (e) {
    handleGitError(e);
    if (useGitStore.getState().errorDialog) revealSourceControl();
  }
}

/** Create `name` from HEAD and switch to it — the branch picker's "Create
 *  branch". Resolves whether it did. */
export async function createAndCheckoutBranch(name: string): Promise<boolean> {
  try {
    await useGitStore.getState().actions.createBranch(name);
    return true;
  } catch (e) {
    handleGitError(e);
    if (useGitStore.getState().errorDialog) revealSourceControl();
    return false;
  }
}
