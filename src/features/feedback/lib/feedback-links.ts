// External destinations from the feedback panel footer.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { FeedbackCategory } from "./feedback-api";

export const DISCORD_URL = "https://discord.gg/GmnFggaPfP";
const ISSUE_BASE = "https://github.com/pacifio/atlas/issues/new";

const PREFIX: Record<FeedbackCategory, string> = {
  issue: "[Bug]",
  feature_request: "[Feature]",
  improvement: "[Improvement]",
  other: "[Feedback]",
};

/** Which issue form each category opens. Both forms use a `description` field id. */
const TEMPLATE: Record<FeedbackCategory, string> = {
  issue: "bug_report.yml",
  feature_request: "feedback.yml",
  improvement: "feedback.yml",
  other: "feedback.yml",
};

/** GitHub rejects very long URLs (~8k). Stay well inside it. */
const MAX_BODY = 4000;

/**
 * A prefilled "new issue" URL carrying whatever the user has typed so far.
 *
 * Issue forms don't have a single body box, so `body=` is ignored once a
 * template is specified — text has to target a field by its `id` instead
 * (here, `description`, which both bug_report.yml and feedback.yml declare).
 */
export function issueUrl(category: FeedbackCategory, message: string): string {
  const text = message.trim();
  const first = text.split("\n")[0]?.slice(0, 90) || "Feedback";
  const title = `${PREFIX[category]} ${first}`;
  const description =
    `${text.slice(0, MAX_BODY)}\n\n---\n` +
    `_Filed from Atlas → Send feedback._\n` +
    `_Attached a screenshot? Drag it in here — a link can't carry it._`;
  const params = new URLSearchParams({
    template: TEMPLATE[category],
    title,
    description,
  });
  return `${ISSUE_BASE}?${params.toString()}`;
}

/** Open in the system browser, with the repo's usual `window.open` fallback. */
export async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}
