/**
 * Announces blocking Security Agent findings (ATL-985) on the shared
 * notification pipeline. `startSecurityNotifier()` (from App.tsx) listens for
 * finished scans; each blocking finding is announced once per run, and only
 * from scans that finished after Atlas started, so a restart stays quiet.
 * Nothing here throws.
 */
import { computeAway } from "@/features/notifications/lib/decide";
import { deliverNotification } from "@/features/notifications/lib/deliver";
import { registerNotificationAction } from "@/features/notifications/lib/notification-actions";
import { prefsFromSettings } from "@/features/notifications/lib/prefs";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import {
  onSecurityScanChanged,
  securityProjectSessions,
  securitySessionCheckpoints,
  securitySetNotUseful,
} from "./security-api";
import { blockingNotices, decideSecurityFinding, NOT_USEFUL_ACTION_ID } from "./security-notify";

// "Not useful" on the notification: the same mark as the card's button. Rust
// announces the write, so the Timeline re-reads.
registerNotificationAction(NOT_USEFUL_ACTION_ID, async ({ target, args }) => {
  if (target.type !== "timeline-session" || !args?.fingerprint || !args.ruleId) return;
  await securitySetNotUseful(target.projectPath, args.fingerprint, args.ruleId, true);
});

let started = false;
const announced = new Set<string>();

async function check(projectPath: string, since: number): Promise<void> {
  try {
    const sessions = await securityProjectSessions(projectPath);
    for (const s of sessions) {
      if (!s.blocking) continue;
      const checkpoints = await securitySessionCheckpoints(projectPath, s.sessionId);
      for (const notice of blockingNotices(checkpoints, announced, since)) {
        const windowFocused = isWindowFocused();
        const sinceInputMs = Date.now() - lastInteraction();
        const d = decideSecurityFinding(
          notice,
          { projectPath, sessionId: s.sessionId },
          {
            windowFocused,
            sinceInputMs,
            targetVisible: false,
            projectActive: true,
            away: computeAway(windowFocused, sinceInputMs),
          },
          prefsFromSettings(useSettingsStore.getState().settings),
        );
        if (d) deliverNotification(d);
      }
    }
  } catch (err) {
    console.warn("security notification failed:", err);
  }
}

export function startSecurityNotifier(): () => void {
  if (started) return () => {};
  started = true;
  const since = Date.now();
  const off = onSecurityScanChanged((projectPath) => void check(projectPath, since));
  return () => {
    started = false;
    void off.then((f) => f()).catch(() => {});
  };
}
