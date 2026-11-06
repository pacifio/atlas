// A review guide's run ended: say so (`decideGuideRun`), and open the pull
// request at its Guide when the notification's Open is pressed — from the
// toast, the notification center, or an OS banner after a cold start.

import { computeAway, type NotificationEnv } from "@/features/notifications/lib/decide";
import { deliverNotification } from "@/features/notifications/lib/deliver";
import type { NotificationTarget } from "@/features/notifications/lib/catalog";
import { prefsFromSettings } from "@/features/notifications/lib/prefs";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";

import { guideRunKey, useGuideRunStore } from "../stores/guide-run-store";
import { decideGuideRun } from "./guide-notifier-rules";
import { openPullRequestTab } from "./open-pull-request-tab";

let seq = 0;

/** A guide run for `repoPath`'s pull request `number` ended. Never throws. */
export function notifyGuideRun(run: {
  repoPath: string;
  number: number;
  title: string | null;
  failure: string | null;
}): void {
  try {
    const windowFocused = isWindowFocused();
    const sinceInputMs = Date.now() - lastInteraction();
    const shown = useGuideRunStore.getState().shownKey === guideRunKey(run.repoPath, run.number);
    const env: NotificationEnv = {
      windowFocused,
      sinceInputMs,
      targetVisible: shown,
      projectActive: useAppStore.getState().currentProject?.path === run.repoPath,
      away: computeAway(windowFocused, sinceInputMs),
    };
    const decision = decideGuideRun(
      { ...run, seq: ++seq },
      env,
      prefsFromSettings(useSettingsStore.getState().settings),
    );
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("review guide notification failed:", err);
  }
}

/** Open a `pull-request` notification target: its project first when it is
 *  one Atlas knows and not the active one, then the tab, at its Guide. */
export async function openPullRequestTarget(
  t: Extract<NotificationTarget, { type: "pull-request" }>,
): Promise<void> {
  const projects = useProjectStore.getState();
  const project = projects.projects.find((p) => p.path === t.repoPath);
  if (project && project.id !== projects.activeProjectId) {
    await projects.actions.switchTo(project.id);
  }
  openPullRequestTab({ repoPath: t.repoPath, number: t.number, title: t.title });
  if (t.view === "guide")
    useGuideRunStore.getState().requestOpen(guideRunKey(t.repoPath, t.number));
}
