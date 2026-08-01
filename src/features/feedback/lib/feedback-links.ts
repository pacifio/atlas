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

/** GitHub rejects very long URLs (~8k). Stay well inside it. */
const MAX_BODY = 4000;

/** A prefilled "new issue" URL carrying whatever the user has typed so far. */
export function issueUrl(category: FeedbackCategory, message: string): string {
  const text = message.trim();
  const first = text.split("\n")[0]?.slice(0, 90) || "Feedback";
  const title = `${PREFIX[category]} ${first}`;
  const body =
    `${text.slice(0, MAX_BODY)}\n\n---\n` +
    `_Filed from Atlas → Send feedback._\n` +
    `_Attached a screenshot? Drag it in here — a link can't carry it._`;
  return `${ISSUE_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** Open in the system browser, with the repo's usual `window.open` fallback. */
export async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}
