/**
 * Image sizing policy for the native agent (spec D15c).
 *
 * The Atlas gateway caps a request body at **2 MB, counted before parsing** —
 * no tokenizer, no provider round trip. Text never approaches it (200K
 * estimated tokens is roughly 600 KB), but base64 images do: a single modern
 * screenshot is often 2-4 MB before encoding, and base64 adds a third on top.
 * So one paste can put a thread over the cap on its very first turn.
 *
 * Two mechanisms defend the cap, and they are deliberately in different places:
 *
 *  - **here, at attach time** — shrink what the user just pasted, once, before
 *    it is ever stored. Doing it on the way out instead would re-encode the
 *    same picture on every turn of the thread.
 *  - **in the request builder** — drop the bytes of images older than the
 *    immediately-preceding turn, since the engine replays the whole
 *    conversation on every request.
 *
 * The decisions live in pure functions so they can be tested; the drawing is a
 * thin wrapper around them, because a canvas cannot be meaningfully asserted on
 * in a unit test and a policy can.
 */

/** The gateway's body cap. */
export const BODY_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The budget one attachment may occupy.
 *
 * A quarter of the cap, not all of it: the body also carries the system prompt,
 * the tool schemas and the whole conversation so far, and a user who attaches
 * two images in one turn should not be refused for it.
 */
export const PER_IMAGE_BUDGET_BYTES = BODY_CAP_BYTES / 4;

/**
 * The longest edge an attachment is reduced to.
 *
 * 1568px is Anthropic's own recommendation — above it the image is downscaled
 * server-side anyway, so the extra pixels cost upload size and buy nothing.
 * Text in a screenshot is still legible at this width, which is what a coding
 * agent is usually being asked to read.
 */
export const MAX_EDGE_PX = 1568;

/** Base64 encodes three bytes as four characters. */
export function encodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * The size an image should be drawn at, or `null` when it is already fine.
 *
 * Aspect ratio is preserved: distorting a screenshot to hit a budget makes it
 * harder to read, which defeats the point of sending it.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether an attachment of this encoded size needs shrinking at all.
 *
 * Measured on the base64 length rather than the raw bytes, because base64 is
 * what actually travels and what the gateway counts.
 */
export function exceedsBudget(base64Length: number): boolean {
  return base64Length > PER_IMAGE_BUDGET_BYTES;
}

/**
 * Successively lower JPEG qualities to try.
 *
 * Re-encoding a screenshot as JPEG is lossy in a way PNG is not, which is the
 * trade being made: a legible 400 KB JPEG beats a pristine 6 MB PNG that the
 * gateway refuses outright.
 */
export const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4] as const;

/**
 * What all staged attachments together may occupy.
 *
 * The per-image budget is enforced per image only, so four in-budget
 * attachments plus the prompt, the tool schemas and the conversation so far
 * could still guarantee a `413` (#71). Three quarters of the cap leaves the
 * last quarter for everything that isn't an image — the same share one image
 * gets. The gateway stays the backstop; crossing this line is a warning owed
 * to the user before they press send, not a refusal.
 */
export const AGGREGATE_IMAGE_BUDGET_BYTES = (BODY_CAP_BYTES * 3) / 4;

/** Whether the staged attachments together are likely to blow the body cap. */
export function aggregateExceedsBudget(base64Lengths: number[]): boolean {
  return base64Lengths.reduce((total, n) => total + n, 0) > AGGREGATE_IMAGE_BUDGET_BYTES;
}
