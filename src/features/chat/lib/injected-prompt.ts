/**
 * Prompts Atlas sends to a session's agent on its own — today, the pull
 * request watch waking the agent when a watched pull request changes
 * (`src-tauri/src/commands/pull_request_watch.rs`).
 *
 * Rust sends the prompt; the session's tab hears `atlas:session-prompt-injected`
 * and draws it as its own row (`InjectedRowView`) rather than as something the
 * user typed. A replayed session has only the prompt's text, so
 * `detectInjectedPrompt` recognises the wake wording to draw the same row.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** What sent an injected prompt. */
export type InjectedPromptSource = "pull-request-watch";

/** How a user-role message came from Atlas rather than the user. */
export interface InjectedPrompt {
  source: InjectedPromptSource;
  /** One line for the row (`#12: checks failed`). */
  summary: string;
}

/** The payload of `atlas:session-prompt-injected` — Rust's `SessionPromptInjected`. */
export interface SessionPromptInjected {
  /** The ACP session the prompt went to. */
  sessionId: string;
  threadId: string;
  /** The prompt, as the agent received it. */
  text: string;
  summary: string;
  source: InjectedPromptSource;
  /** RFC 3339. */
  at: string;
}

export const SESSION_PROMPT_INJECTED_EVENT = "atlas:session-prompt-injected";

export function listenSessionPromptInjected(
  handler: (event: SessionPromptInjected) => void,
): Promise<UnlistenFn> {
  return listen<SessionPromptInjected>(SESSION_PROMPT_INJECTED_EVENT, (e) => handler(e.payload));
}

/** The openings of the pull request watch's wakes (`message`,
 *  `closed_message`, `unreadable_message` in `pull_request_watch.rs`). */
const WAKE_OPENINGS: Array<[RegExp, string]> = [
  [/^Update on pull request #(\d+) \(\S+\), which Atlas is watching for you:/, "update"],
  [/^Pull request #(\d+) \(\S+\) was closed, so Atlas stopped watching it\./, "closed"],
  [
    /^Atlas stopped watching pull request #(\d+) \(\S+\) because it failed to read it/,
    "stopped watching, could not read it",
  ],
];

/** The injected prompt a replayed user message's `text` is, or null. The
 *  live summary is not in the text, so a replayed row says less. */
export function detectInjectedPrompt(text: string): InjectedPrompt | null {
  for (const [opening, what] of WAKE_OPENINGS) {
    const m = opening.exec(text);
    if (m) return { source: "pull-request-watch", summary: `#${m[1]}: ${what}` };
  }
  return null;
}
