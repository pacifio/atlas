// The capture popover's copy that is computed from numbers.

import type { ImportPreview, PromotionPreview } from "../types";

/**
 * Why the server bound nothing, as one sentence the developer can act on.
 * Shared by the unbound Connect tab and the promote-onto-existing confirm.
 */
export function connectRefusal(candidates: unknown[]): string {
  return candidates.length > 0
    ? `${candidates.length} Projects share this repository’s root commit. Pick the right one — repositories created from the same template look identical here.`
    : "The server did not recognize this pick. Reopen this tab to refresh the Project list.";
}

export function disclosureLines(preview: ImportPreview): string[] {
  if (preview.newSessionCount === 0) {
    return ["No existing history to import — new sessions sync from now on."];
  }
  return [
    `${preview.newSessionCount} session${preview.newSessionCount === 1 ? "" : "s"} on disk`,
    dateRange(preview.earliest, preview.latest),
    `${formatBytes(preview.totalBytes)} of transcripts, secrets scrubbed on the way in`,
  ].filter((line): line is string => line !== null);
}

/** What promotion publishes — the same three lines whether the destination is new or existing. */
export function promotionLines(preview: PromotionPreview): string[] {
  return [
    `${preview.sessionCount} session${preview.sessionCount === 1 ? "" : "s"}`,
    dateRange(preview.earliest, preview.latest),
    `${preview.secretsRedacted} secret${preview.secretsRedacted === 1 ? "" : "s"} redacted before storage`,
  ].filter((line): line is string => line !== null);
}

function dateRange(earliest: string | null, latest: string | null): string | null {
  if (!earliest || !latest) return null;
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
  };
  const from = new Date(earliest).toLocaleDateString(undefined, options);
  const to = new Date(latest).toLocaleDateString(undefined, options);
  return from === to ? from : `${from} – ${to}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
