// When to suggest downloading the code search model. Without it,
// `semantic_search` quietly runs keyword + symbol only and says so only in the
// agent's tool output, which the user never reads, so plain-English questions
// miss answers with nothing on screen to explain why.

import type { ModelStatus } from "./models-api";

const DISMISSED_KEY = "atlas:code-model-nudge:dismissed:v1";

/** The selected code model, when it is missing and the user hasn't waved the
 *  suggestion off for it. `null` means: show nothing. Dismissal is per model,
 *  so picking a different code model asks again. */
export function codeModelToSuggest(
  list: readonly ModelStatus[],
  dismissed: readonly string[],
): ModelStatus | null {
  const model = list.find((m) => m.kind === "code_embedding" && m.selected);
  if (!model || model.downloaded || !model.compatible) return null;
  return dismissed.includes(model.id) ? null : model;
}

export function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function dismiss(id: string): string[] {
  const next = [...new Set([...readDismissed(), id])];
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the pill still hides for this session.
  }
  return next;
}

/** Overall download progress, 0–100, across a model's files. */
export function downloadPercent(p: {
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number;
}): number {
  const file = p.total ? p.received / p.total : 0;
  return Math.min(100, Math.round(((p.fileIndex + file) / Math.max(1, p.fileCount)) * 100));
}
