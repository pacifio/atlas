// Opening the ask box, and "Fix with agent" as a toast's action: the part of
// ask-agent (`./ask-agent.ts`, which re-exports both) that needs only the
// box's store, so any module can import it without the chat and layout
// stores that sending pulls in.

import { useAskAgentStore, type AskAnchor } from "../stores/ask-agent-store";
import { capContext, type AgentContext, type ErrorContext } from "./agent-context";

/** Where the ask goes: the session in view, a new one, or an open session's
 *  tab id. */
export type AskTarget = "active" | "new" | (string & {});

/** Open the ask box, pre-filled, against `anchor` (an element, a rect, or
 *  nothing for the top of the window). `suggestions` are quick prompts the
 *  box offers above the field; picking one fills the prompt, never sends. */
export function openAskAgent(request: {
  context?: readonly AgentContext[];
  prompt?: string;
  suggestions?: readonly string[];
  anchor?: AskAnchor;
  target?: AskTarget;
}): void {
  useAskAgentStore.getState().actions.open({
    context: (request.context ?? []).map(capContext),
    prompt: request.prompt,
    suggestions: request.suggestions,
    anchor: request.anchor ?? null,
    target: request.target,
  });
}

/** "Fix with agent" as a toast's action, for an error that surfaces as a
 *  toast rather than in a view (`FixWithAgentButton` there). The toast closes
 *  on the click, so the box grows from where the button was. */
export function fixWithAgentAction(error: ErrorContext): {
  label: string;
  onClick: (event: { currentTarget: EventTarget | null }) => void;
} {
  return {
    label: "Fix with agent",
    onClick: (event) => {
      const el = event.currentTarget;
      const anchor = el instanceof Element ? el.getBoundingClientRect() : null;
      openAskAgent({ context: [error], prompt: "Fix this: ", anchor });
    },
  };
}
