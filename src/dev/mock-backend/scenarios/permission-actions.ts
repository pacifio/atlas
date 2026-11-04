// Every blocking prompt a session can raise, callable from any chat scenario
// once a session is bound (`__atlasMock.actions.<name>()`). Each raises the
// real wire shape — a `permission_request` or `elicitation_requested` delta,
// or the `atlas:agent-elicitation` event — so the surface under review is the
// one a live agent produces. See `fake-agent.ts` for each.

import {
  aiGrantNoGrant,
  requestElicitationForm,
  requestElicitationQuestion,
  requestElicitationUrl,
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionOutward,
  requestPermissionOutwardMessage,
  requestPermissionOutwardPreparing,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
  requestSignInElicitation,
} from "../fake-agent";

export const permissionActions = {
  // `permission-modal.tsx`: a plain command, a long/multi-line one, the
  // ExitPlanMode review, Claude's AskUserQuestion bridge (single and
  // multi-question), and the outward action's three cards (ADR-0014).
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
  requestPermissionOutward,
  requestPermissionOutwardMessage,
  requestPermissionOutwardPreparing,
  // `session-elicitation.tsx`: a form (the dialog), a URL, and an
  // AskUserQuestion-shaped form (the question card with Decline).
  requestElicitationForm,
  requestElicitationUrl,
  requestElicitationQuestion,
  // `agent-elicitation-host.tsx`: a question asked during sign-in.
  requestSignInElicitation,
  // `ai-grant-bar.tsx`: the native agent's no-grant strip on the composer.
  aiGrantNoGrant,
};
