import type { ToolCallRef } from "@/types/acp";

/**
 * Claude Code's `AskUserQuestion` tool lets the agent ask the user one or more
 * multiple-choice questions before continuing. Its input shape is:
 *
 *   { questions: [ { header, question, multiSelect, options: [{ label, description }] } ] }
 *
 * The ACP bridge surfaces that under `rawInput` (or `input`) on the permission
 * tool call — exactly like ExitPlanMode's `{ plan }`. We render it as a proper
 * question card instead of a raw tool-call card.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  /** Short category label, e.g. "Approach". */
  header?: string;
  /** The full question text. */
  question: string;
  /** Whether the agent expects multiple selections. */
  multiSelect?: boolean;
  options: QuestionOption[];
}

/**
 * Pull the structured questions out of an `AskUserQuestion` permission tool
 * call. Returns the parsed specs when present and non-empty, else null (so the
 * caller falls back to the generic permission card). Defensive about the exact
 * shape — option items may be `{label, description}`, `{name}`, or plain strings
 * depending on how the adapter serializes them.
 */
export function extractQuestions(tc: ToolCallRef): QuestionSpec[] | null {
  const record = tc as Record<string, unknown>;
  const input = (record.rawInput ?? record.input) as unknown;
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const specs: QuestionSpec[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === "string" ? qo.question : "";
    const header = typeof qo.header === "string" ? qo.header : undefined;
    const multiSelect = typeof qo.multiSelect === "boolean" ? qo.multiSelect : undefined;

    const options: QuestionOption[] = [];
    const optsRaw = Array.isArray(qo.options) ? qo.options : [];
    for (const o of optsRaw) {
      if (typeof o === "string") {
        if (o.trim()) options.push({ label: o });
        continue;
      }
      if (o && typeof o === "object") {
        const oo = o as Record<string, unknown>;
        const label =
          (typeof oo.label === "string" && oo.label) ||
          (typeof oo.name === "string" && oo.name) ||
          "";
        if (!label) continue;
        const description = typeof oo.description === "string" ? oo.description : undefined;
        options.push({ label, description });
      }
    }

    if (!question && options.length === 0) continue;
    specs.push({ header, question, multiSelect, options });
  }

  return specs.length > 0 ? specs : null;
}

/** Compose the free-text form of every answer, one line per question.
 *
 *  The fallback when an answer cannot be expressed as a protocol option: the
 *  agent reads it as an ordinary user message, so it has to name which question
 *  each answer belongs to whenever there is more than one. */
export function composeAnswers(
  questions: QuestionSpec[],
  answers: { selected: string[]; custom: string }[],
): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    const value = a.custom.trim() || a.selected.join(", ");
    if (!value) return;
    const label = q.header || q.question;
    lines.push(questions.length === 1 ? value : `${label}: ${value}`);
  });
  return lines.join("\n");
}
