// What the Memory panel's summarizer popover says. Kept here, tested, so the
// copy can't drift from what the backend does again (it once said "injected"
// and "no model call" while extraction went to the gateway).

/** The popover's lead line. */
export const HANDOFF_HINT =
  "How the previous session's last turns are condensed before the next agent reads them in its memory briefing.";

/** Shown under the mode switch when Raw is chosen. */
export const RAW_HINT =
  "Raw: the next agent reads the last turns as written (redacted). No model call for the handoff.";

/** Always shown: what extraction does with the session, whatever the mode. */
export const EXTRACTION_NOTE =
  "While Shared is on and you're signed in, Atlas also sends a redacted excerpt of long sessions to the Atlas model to extract decisions and facts. Choose Provider to use your own key instead.";

/** The switch that lets extraction read sessions Atlas did not host. */
export const EXTERNAL_SESSIONS_LABEL = "Learn from sessions outside Atlas";

/** What that switch does, said plainly: what is read and where it goes. */
export const EXTERNAL_SESSIONS_HINT =
  "Also extracts memories from coding-agent sessions Atlas imported from your terminal. Their transcripts are sent to the extraction model, the same as in-app sessions. Off by default.";

/** Shown instead while Shared is off, when the switch can't do anything. */
export const EXTERNAL_SESSIONS_NEEDS_SHARING = "Turn on Shared to use this.";
