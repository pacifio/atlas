// The Guide tab's shapes: a review guide is a tour of a pull request in
// numbered stops, written by an agent for one head commit.
//
// `parseGeneratedGuide` is the check the agent's answer passes before it is
// kept: the answer is model output, so every field is read defensively and a
// wrong shape is refused rather than rendered.

export type GuideAttentionKind = "tradeoff" | "contract" | "product" | "risk" | "accessibility";

export interface GuideAttention {
  kind: GuideAttentionKind;
  note: string;
}

export interface GuideExcerpt {
  path: string;
  side: "new" | "old";
  start: number;
  end: number;
  caption: string;
}

export interface GuideNote {
  path: string;
  line: number;
  title: string;
  body: string;
}

export interface GuideFile {
  path: string;
  note?: string;
}

export interface GuideStop {
  title: string;
  summary: string;
  attention: GuideAttention | null;
  excerpts: GuideExcerpt[];
  files: GuideFile[];
  notes: GuideNote[];
  questions: string[];
}

/** What the agent returns. */
export interface GeneratedGuide {
  stops: GuideStop[];
}

/** A kept guide: the stops, and what they were written for and by. */
export interface PullRequestGuide extends GeneratedGuide {
  /** The head commit the guide was written for. */
  headSha: string;
  generatedAt: string;
  /** The agent that wrote it (`agentMeta` resolves the name). */
  agent: string;
}

/** The change a guide is written against, from `pr_guide_prepare`. */
export interface GuideChange {
  files: string[];
  hunks: Record<string, { new: [number, number][]; old: [number, number][] }>;
}

export interface GuideCheckout {
  runId: string;
  path: string;
  baseCommit: string;
  headCommit: string;
  change: GuideChange;
}

const ATTENTION_KINDS: readonly GuideAttentionKind[] = [
  "tradeoff",
  "contract",
  "product",
  "risk",
  "accessibility",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseStop(raw: unknown): GuideStop | null {
  if (!isRecord(raw)) return null;
  const attention = isRecord(raw.attention) ? raw.attention : null;
  const kind = attention ? (attention.kind as GuideAttentionKind) : null;
  return {
    title: str(raw.title).trim(),
    summary: str(raw.summary),
    attention:
      attention && kind && ATTENTION_KINDS.includes(kind)
        ? { kind, note: str(attention.note).trim() }
        : null,
    excerpts: list(raw.excerpts).flatMap((item): GuideExcerpt[] => {
      if (!isRecord(item)) return [];
      const start = positiveInt(item.start);
      const end = positiveInt(item.end);
      const path = str(item.path).trim();
      const side = item.side === "old" ? "old" : item.side === "new" ? "new" : null;
      if (!path || !side || start === null || end === null) return [];
      return [{ path, side, start, end, caption: str(item.caption) }];
    }),
    files: list(raw.files).flatMap((item): GuideFile[] => {
      if (!isRecord(item)) return [];
      const path = str(item.path).trim();
      if (!path) return [];
      const note = str(item.note);
      return [note.trim() ? { path, note } : { path }];
    }),
    notes: list(raw.notes).flatMap((item): GuideNote[] => {
      if (!isRecord(item)) return [];
      const line = positiveInt(item.line);
      const path = str(item.path).trim();
      const title = str(item.title).trim();
      if (!path || !title || line === null) return [];
      return [{ path, line, title, body: str(item.body) }];
    }),
    questions: list(raw.questions)
      .map((q) => str(q).trim())
      .filter((q) => q.length > 0),
  };
}

/**
 * The first JSON object in `text` that parses: the agent may wrap its answer
 * in a fence or a sentence, as models do.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/u.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The agent's answer as a guide, or `null` when it is not one. */
export function parseGeneratedGuide(text: string): GeneratedGuide | null {
  const raw = extractJsonObject(text);
  if (!isRecord(raw) || !Array.isArray(raw.stops)) return null;
  const stops = raw.stops.map(parseStop).filter((s): s is GuideStop => s !== null);
  return { stops };
}

/** A kept guide read back from disk, or `null` when it is not one. */
export function parseStoredGuide(raw: unknown): PullRequestGuide | null {
  if (!isRecord(raw) || !Array.isArray(raw.stops)) return null;
  const headSha = str(raw.headSha);
  if (!headSha) return null;
  return {
    headSha,
    generatedAt: str(raw.generatedAt),
    agent: str(raw.agent),
    stops: raw.stops.map(parseStop).filter((s): s is GuideStop => s !== null && s.title !== ""),
  };
}
