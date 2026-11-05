// What a review guide's run says when it ends: the `pull-request-guide`
// notification, decided purely (the side effects are `guide-notifier.ts`).
//
// While that pull request's Guide is on screen and being looked at, nothing
// (the kind drops when looking: the guide or its failure is right there).
// Otherwise a toast with Open, and an OS banner when the user is away, as
// `decideNotification` rules for every outcome.

import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationPrefs,
} from "@/features/notifications/lib/decide";

export interface GuideRunOutcome {
  repoPath: string;
  number: number;
  /** The pull request's title, when known. */
  title: string | null;
  /** Why the run failed; `null` when the guide was written. */
  failure: string | null;
  /** Distinguishes one run's end from the next one's. */
  seq: number;
}

const FAILURE_MAX_CHARS = 200;

function trimmed(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > FAILURE_MAX_CHARS ? `${flat.slice(0, FAILURE_MAX_CHARS - 1)}…` : flat;
}

export function decideGuideRun(
  outcome: GuideRunOutcome,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const { repoPath, number, title, failure } = outcome;
  const name = title ? `#${number} ${title}` : `Pull request #${number}`;
  return decideNotification(
    {
      kind: "pull-request-guide",
      title: failure === null ? "Review guide ready" : "Review guide failed",
      body: failure === null ? name : `${name}: ${trimmed(failure)}`,
      target: {
        type: "pull-request",
        repoPath,
        number,
        ...(title ? { title } : {}),
        view: "guide",
      },
      dedupeKey: `pull-request-guide:${repoPath}:${number}:${outcome.seq}`,
    },
    env,
    prefs,
  );
}
