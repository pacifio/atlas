// IPC surface for the feedback panel.
//
// Rust owns identity: this sends a single `anonymous` bit and never the user's
// id, name, or email. The credential lives in Rust and the account is resolved
// there, so a payload that also carries a screenshot can never accidentally
// carry a person.

import { invoke } from "@tauri-apps/api/core";

export type FeedbackCategory = "issue" | "feature_request" | "improvement" | "other";

export const CATEGORIES: ReadonlyArray<{
  id: FeedbackCategory;
  label: string;
  placeholder: string;
}> = [
  {
    id: "issue",
    label: "Issue",
    placeholder: "What broke? What were you doing right before?",
  },
  {
    id: "feature_request",
    label: "Feature request",
    placeholder: "What would you like Atlas to do?",
  },
  {
    id: "improvement",
    label: "Improve",
    placeholder: "What feels clumsy, slow, or confusing?",
  },
  { id: "other", label: "Other", placeholder: "Anything on your mind." },
];

/** Mirror of Rust `CaptureResult` (src-tauri/src/commands/fs.rs). */
export interface CaptureResult {
  path: string;
  mimeType: string;
  dataBase64: string;
}

export interface FeedbackPayload {
  category: FeedbackCategory;
  message: string;
  anonymous: boolean;
  /** Downscaled image, bare base64 (no `data:` prefix). */
  screenshotBase64: string | null;
  screenshotMimeType: string | null;
  source: "status-bar" | "settings";
  /** Tab *type* only (e.g. "chat") — never a title or a path. */
  activeTab: string | null;
}

export interface FeedbackReceipt {
  sent: boolean;
  /** What actually happened, not what was asked for. */
  anonymous: boolean;
  /** The screenshot was too large to carry; the report still went. */
  screenshotDropped: boolean;
}

export const feedback = {
  submit: (input: FeedbackPayload) => invoke<FeedbackReceipt>("feedback_submit", { input }),

  /**
   * Native macOS capture. `"region"` lets the user drag a region *or* press
   * Space and click to grab the whole Atlas window, which covers "a screenshot
   * of the app" without a second menu.
   *
   * `projectPath: null` on purpose — a feedback screenshot has no business being
   * written into the user's repository, so it lands in the temp dir. Resolves to
   * `null` when the user cancels with Esc, which is not an error.
   */
  capture: () =>
    invoke<CaptureResult | null>("capture_screenshot", {
      mode: "region",
      projectPath: null,
    }),
};

/**
 * Downscale a captured PNG to a JPEG small enough to travel with the event.
 *
 * Done here rather than in Rust because the preview needs the decoded image in
 * the renderer anyway, and there is no image crate on the Rust side — the canvas
 * is already present and free. Rust still enforces its own hard cap; this just
 * means a normal screenshot lands well under it.
 */
export async function downscaleForUpload(
  shot: CaptureResult,
  maxEdge = 1280,
  quality = 0.75,
): Promise<{ base64: string; mimeType: string }> {
  const src = `data:${shot.mimeType};base64,${shot.dataBase64}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("could not decode screenshot"));
    el.src = src;
  });

  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { base64: shot.dataBase64, mimeType: shot.mimeType };
  ctx.drawImage(img, 0, 0, w, h);

  const url = canvas.toDataURL("image/jpeg", quality);
  const comma = url.indexOf(",");
  return {
    base64: comma >= 0 ? url.slice(comma + 1) : shot.dataBase64,
    mimeType: "image/jpeg",
  };
}
