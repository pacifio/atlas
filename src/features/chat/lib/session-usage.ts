import type { ModelPrice } from "@/features/settings/stores/model-pricing-store";
import type { SessionSummary } from "@/features/artifacts/types";
import { fmtTokens } from "@/features/monitor/lib/usage-format";

/**
 * One session's usage, derived from everything Atlas knows about it, shaped
 * for the composer's Usage pill and popup.
 *
 * The rule the whole shape follows: **a section exists only when its data
 * does.** Every agent reports something different — an ACP adapter sends a
 * context gauge and (Claude) an end-of-turn token split; the native engine a
 * running split with cache and reasoning halves; none of them a price — and a
 * card that fills the gaps with zeroes is what the old status-bar widget was.
 * `null` here means "don't render that", not "zero".
 *
 * Pure. The hook in `use-session-usage.ts` gathers the inputs; this decides
 * what they mean.
 */

/** Mirrors `TOKEN_USAGE_WARNING_THRESHOLD` in atlas-acp-thread. */
export const CONTEXT_WARN = 0.8;

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
}

export interface RateLimits {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

export interface SessionUsageInput {
  agentType: string;
  model: string | null;
  contextUsed: number | null;
  contextSize: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** What the AGENT said it cost. `null` when it said nothing. */
  agentCost: number | null;
  compacting: boolean;
  pendingSavedTokens: number | null;
  rateLimits: RateLimits | null;
  /** Assistant turns and total messages in the live transcript. */
  turns: number;
  messages: number;
  /** models.dev rate for `model`, or `null` when it is not in the map. */
  price: ModelPrice | null;
  /** The persisted record, when capture has one for this session. */
  summary: SessionSummary | null;
}

export type MetricKey = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

export interface MetricRow {
  key: MetricKey;
  label: string;
  value: number;
  /** Share of the largest row, for the inline bar. */
  frac: number;
  /** USD, or `null` when this row is not priced on its own. */
  cost: number | null;
}

export type ContextStatus = "ok" | "warn" | "full";

export type Headline =
  | { kind: "context"; pct: number; used: number; size: number; status: ContextStatus }
  | { kind: "tokens"; total: number }
  | { kind: "cost"; usd: number; estimated: boolean };

export interface SessionUsageView {
  headline: Headline | null;
  tokens: MetricRow[] | null;
  cost: { total: number; estimated: boolean; rows: MetricRow[] } | null;
  quota: {
    primary: RateLimitWindow | null;
    secondary: RateLimitWindow | null;
    plan: string | null;
  } | null;
  session: {
    turns: number | null;
    messages: number | null;
    toolCalls: number | null;
    filesTouched: number | null;
    insertions: number | null;
    deletions: number | null;
    activeSeconds: number | null;
    checkpoints: number | null;
  } | null;
  compacting: boolean;
  savedTokens: number | null;
  pill: {
    label: string;
    tint: "none" | "warn" | "error";
    /** 0..1 context share for the ring, or `null` when no window is known. */
    ringFrac: number | null;
    state: "context" | "tokens" | "idle" | "compacting";
    /** Tooltip / aria-label: used tokens, total window, and percentage. */
    hint: string;
  };
}

/** USD for a token split at a models.dev rate (rates are per 1M tokens). */
export function estimateCost(
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
  price: ModelPrice,
): number {
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      t.cacheWrite * price.cacheWrite) /
    1e6
  );
}

export function contextStatus(pct: number): ContextStatus {
  if (pct >= 100) return "full";
  if (pct >= CONTEXT_WARN * 100) return "warn";
  return "ok";
}

const nz = (n: number | null | undefined): number => (n && n > 0 ? n : 0);

const IDLE_HINT = "Session usage — context, tokens, cost and what Atlas recorded";

function contextReading(used: number, size: number, pct: number): string {
  return `${used.toLocaleString()} of ${size.toLocaleString()} tokens used (${Math.round(Math.min(pct, 999))}%)`;
}

/** Screen-reader / tooltip copy for a known context window. */
export function contextUsageHint(used: number, size: number, pct: number): string {
  return `Context: ${contextReading(used, size, pct)}`;
}

export function deriveSessionUsage(i: SessionUsageInput): SessionUsageView {
  // ── The split: live first, the record when live has nothing yet (a
  // reopened ACP session before its next turn) ──────────────────────────
  const liveTotal = nz(i.input) + nz(i.output) + nz(i.cacheRead) + nz(i.cacheWrite);
  const s = i.summary;
  const split =
    liveTotal > 0 || !s
      ? {
          input: nz(i.input),
          output: nz(i.output),
          cacheRead: nz(i.cacheRead),
          cacheWrite: nz(i.cacheWrite),
          reasoning: nz(i.reasoning),
        }
      : {
          input: nz(s.inputTokens),
          output: nz(s.outputTokens),
          cacheRead: nz(s.cacheReadTokens),
          cacheWrite: nz(s.cacheCreationTokens),
          reasoning: 0,
        };
  const splitTotal = split.input + split.output + split.cacheRead + split.cacheWrite;

  // ── Cost: what the agent said, else what the price map implies ────────
  let cost: SessionUsageView["cost"] = null;
  let rowCost = (_k: MetricKey, _v: number): number | null => null;
  if (i.agentCost && i.agentCost > 0) {
    cost = { total: i.agentCost, estimated: false, rows: [] };
  } else if (i.price && splitTotal > 0) {
    const p = i.price;
    const rate: Record<MetricKey, number | null> = {
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      // Reasoning rides inside output for every engine that reports it.
      reasoning: null,
    };
    rowCost = (k, v) => (rate[k] === null ? null : (v * (rate[k] as number)) / 1e6);
    cost = { total: estimateCost(split, p), estimated: true, rows: [] };
  }

  // ── Token rows, only where there is something to show ─────────────────
  const candidates: Array<[MetricKey, string, number]> = [
    ["input", "Input", split.input],
    ["output", "Output", split.output],
    ["cacheRead", "Cache read", split.cacheRead],
    ["cacheWrite", "Cache write", split.cacheWrite],
    ["reasoning", "Reasoning", split.reasoning],
  ];
  const present = candidates.filter(([, , v]) => v > 0);
  const max = present.reduce((m, [, , v]) => Math.max(m, v), 0);
  const tokens: MetricRow[] | null = present.length
    ? present.map(([key, label, value]) => ({
        key,
        label,
        value,
        frac: max > 0 ? value / max : 0,
        cost: rowCost(key, value),
      }))
    : null;
  if (cost && tokens) cost = { ...cost, rows: tokens.filter((r) => r.cost !== null) };

  // ── Context gauge ─────────────────────────────────────────────────────
  const hasContext = i.contextUsed !== null && i.contextSize !== null && i.contextSize > 0;
  const ctxUsed = hasContext ? (i.contextUsed as number) : (s?.contextUsed ?? null);
  const ctxSize = hasContext ? (i.contextSize as number) : (s?.contextSize ?? null);
  const context =
    ctxUsed !== null && ctxSize !== null && ctxSize > 0
      ? { used: ctxUsed, size: ctxSize, pct: (ctxUsed / ctxSize) * 100 }
      : null;

  // ── Headline: the most important number that exists ───────────────────
  let headline: Headline | null = null;
  if (context) {
    headline = { kind: "context", ...context, status: contextStatus(context.pct) };
  } else if (splitTotal > 0) {
    headline = { kind: "tokens", total: splitTotal };
  } else if (cost) {
    headline = { kind: "cost", usd: cost.total, estimated: cost.estimated };
  }

  // ── Quota (native engine only) ────────────────────────────────────────
  const quota =
    i.rateLimits && (i.rateLimits.primary || i.rateLimits.secondary)
      ? {
          primary: i.rateLimits.primary,
          secondary: i.rateLimits.secondary,
          plan: i.rateLimits.planType,
        }
      : null;

  // ── The session record ────────────────────────────────────────────────
  const turns = i.turns > 0 ? i.turns : null;
  const messages = s ? s.messageCount : i.messages > 0 ? i.messages : null;
  const session =
    s || turns !== null || messages !== null
      ? {
          turns,
          messages,
          toolCalls: s ? s.toolCallCount : null,
          filesTouched: s ? s.filesTouched : null,
          insertions: s ? s.insertions : null,
          deletions: s ? s.deletions : null,
          activeSeconds: s && s.activeSeconds > 0 ? s.activeSeconds : null,
          checkpoints: s && s.checkpointCount > 0 ? s.checkpointCount : null,
        }
      : null;

  // ── The pill ──────────────────────────────────────────────────────────
  // The ring stays in the layout even without a window (dashed track) and
  // keeps its fill while compacting, so a mid-run gauge tick cannot swap the
  // glyph and shove the footer.
  const ringFrac = context ? Math.min(1, context.pct / 100) : null;
  let pill: SessionUsageView["pill"];
  if (i.compacting) {
    pill = {
      label: "Compacting…",
      tint: "none",
      ringFrac,
      state: "compacting",
      hint: context
        ? `Compacting context — ${contextReading(context.used, context.size, context.pct)}`
        : "Compacting the context window",
    };
  } else if (context) {
    const status = contextStatus(context.pct);
    pill = {
      label: `${Math.round(Math.min(context.pct, 999))}%`,
      tint: status === "full" ? "error" : status === "warn" ? "warn" : "none",
      ringFrac,
      state: "context",
      hint: contextUsageHint(context.used, context.size, context.pct),
    };
  } else if (splitTotal > 0) {
    pill = {
      label: fmtTokens(splitTotal),
      tint: "none",
      ringFrac: null,
      state: "tokens",
      hint: `Session usage — ${fmtTokens(splitTotal)} tokens`,
    };
  } else {
    pill = { label: "Usage", tint: "none", ringFrac: null, state: "idle", hint: IDLE_HINT };
  }

  return {
    headline,
    tokens,
    cost,
    quota,
    session,
    compacting: i.compacting,
    savedTokens: i.pendingSavedTokens && i.pendingSavedTokens > 0 ? i.pendingSavedTokens : null,
    pill,
  };
}
