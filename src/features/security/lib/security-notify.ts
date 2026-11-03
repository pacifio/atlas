import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationPrefs,
} from "@/features/notifications/lib/decide";
import { OPEN_ACTION_ID } from "@/features/notifications/lib/catalog";
import type { CheckpointSecurity } from "../types";
import { ROTATE, secretLabel, whereLabel } from "./security-levels";

/** The notification's "Not useful" button; handled in `security-notifier.ts`. */
export const NOT_USEFUL_ACTION_ID = "security.not-useful";

export interface SecurityNotice {
  fingerprint: string;
  ruleId: string;
  checkpointId: string;
  commitSha: string;
  title: string;
  body: string;
}

/**
 * What to announce from freshly scanned checkpoints: each blocking finding
 * once (by fingerprint), never one marked "Not useful". Everything below
 * blocking waits quietly on the Timeline. Checkpoints scanned before `since`
 * (epoch ms) are skipped, so a restart does not announce old findings again.
 * Adds what it returns to `announced`.
 */
export function blockingNotices(
  checkpoints: CheckpointSecurity[],
  announced: Set<string>,
  since = 0,
): SecurityNotice[] {
  const out: SecurityNotice[] = [];
  for (const cp of checkpoints) {
    if (Date.parse(cp.scannedAt) < since) continue;
    for (const f of cp.findings) {
      if (!f.blocking || f.notUseful || announced.has(f.fingerprint)) continue;
      announced.add(f.fingerprint);
      const where = `${whereLabel(f)}, commit ${cp.commitSha.slice(0, 7)}`;
      const secret = secretLabel(f.ruleId);
      out.push({
        fingerprint: f.fingerprint,
        ruleId: f.ruleId,
        checkpointId: cp.checkpointId,
        commitSha: cp.commitSha,
        title: secret ? "A credential was committed" : "A blocking security issue was committed",
        body: secret ? `${secret} in ${where}. ${ROTATE}` : `${f.reason} Found in ${where}.`,
      });
    }
  }
  return out;
}

/** The notification for one blocking finding; "Open" lands on the session's
 *  Checkpoint for that commit. Null when Settings has it switched off. */
export function decideSecurityFinding(
  notice: SecurityNotice,
  where: { projectPath: string; sessionId: string },
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  return decideNotification(
    {
      kind: "security-finding",
      title: notice.title,
      body: notice.body,
      target: {
        type: "timeline-session",
        projectPath: where.projectPath,
        sessionId: where.sessionId,
        commitSha: notice.commitSha,
      },
      dedupeKey: `security:${where.projectPath}:${notice.fingerprint}`,
      actions: [
        { id: OPEN_ACTION_ID, label: "Open" },
        {
          id: NOT_USEFUL_ACTION_ID,
          label: "Not useful",
          args: { fingerprint: notice.fingerprint, ruleId: notice.ruleId },
        },
      ],
    },
    env,
    prefs,
  );
}
