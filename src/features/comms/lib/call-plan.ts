import type { ChatFeatures } from "../types";

/**
 * Which call buttons the conversation header offers, from the Organisation's
 * features — the web client's `callButtonPlan` (server repo,
 * `apps/web/src/lib/calls.ts`), mirrored so the two clients agree:
 *
 * - The **phone** starts a free Voice Call (`provider: "mesh"`) when
 *   `calls.mesh` is on. With `calls.paid` on as well it also offers an audio
 *   Meeting with a guest link, the one thing a Voice Call cannot do. With
 *   `calls.mesh` off and `calls.paid` on it is the audio Meeting menu; with
 *   both off there is nothing to start.
 * - The **camera** is a video Meeting (`provider: "rtk"`), so it exists only
 *   with `calls.paid`.
 *
 * `features` is undefined until `comms_features` answers (or when it failed);
 * the catalogue defaults are assumed meanwhile — Voice Calls on, Meetings
 * off — which is what nearly every Organisation has. Every start is checked
 * again server-side, so a wrong guess costs a refusal toast, never a bypass.
 */
export interface CallButtonPlan {
  phone: { kind: "voice"; guestMeeting: boolean } | { kind: "meeting" } | null;
  video: boolean;
}

export function callButtonPlan(features: ChatFeatures["features"] | undefined): CallButtonPlan {
  const mesh = features?.["calls.mesh"] ?? true;
  const paid = features?.["calls.paid"] ?? false;
  return {
    phone: mesh ? { kind: "voice", guestMeeting: paid } : paid ? { kind: "meeting" } : null,
    video: paid,
  };
}

/** Why a call button that the plan rules out is drawn disabled. */
export const NO_MEETINGS_REASON = "Video meetings aren't included in this organization's plan";
export const NO_CALLS_REASON = "Calls aren't available on this organization's plan";
