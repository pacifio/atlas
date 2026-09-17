import { describe, expect, it } from "vitest";
import {
  CONTEXT_WARN,
  contextStatus,
  contextUsageHint,
  deriveSessionUsage,
  estimateCost,
  type SessionUsageInput,
} from "./session-usage";
import type { SessionSummary } from "@/features/artifacts/types";
import { NATIVE_AGENT_ID } from "@/types/agent";

const base: SessionUsageInput = {
  agentType: "claude-code",
  model: "claude-opus-5",
  contextUsed: null,
  contextSize: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  agentCost: null,
  compacting: false,
  pendingSavedTokens: null,
  rateLimits: null,
  turns: 0,
  messages: 0,
  price: null,
  summary: null,
};

const price = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "row-1",
  title: "t",
  agent: "claude-code",
  model: "claude-opus-5",
  source: "acp",
  startedAt: "2026-09-16T00:00:00Z",
  updatedAt: "2026-09-16T00:00:00Z",
  lastActivityAt: "2026-09-16T00:00:00Z",
  activeSeconds: 0,
  wallSeconds: 0,
  messageCount: 0,
  toolCallCount: 0,
  checkpointCount: 0,
  branches: [],
  insertions: 0,
  deletions: 0,
  filesTouched: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  contextUsed: null,
  contextSize: null,
  needsAttention: false,
  attentionReason: null,
  ...over,
});

describe("contextStatus", () => {
  it("warns at the ACP thread's threshold and reads full at the window", () => {
    expect(contextStatus(CONTEXT_WARN * 100 - 0.1)).toBe("ok");
    expect(contextStatus(CONTEXT_WARN * 100)).toBe("warn");
    expect(contextStatus(100)).toBe("full");
  });
});

describe("contextUsageHint", () => {
  it("spells out used tokens, the window, and the percentage", () => {
    expect(contextUsageHint(84_200, 200_000, 42.1)).toBe(
      `Context: ${(84_200).toLocaleString()} of ${(200_000).toLocaleString()} tokens used (42%)`,
    );
  });
});

describe("estimateCost", () => {
  it("prices per million tokens, cache halves at their own rates", () => {
    expect(estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, price)).toBe(
      15,
    );
    expect(
      estimateCost({ input: 0, output: 0, cacheRead: 2_000_000, cacheWrite: 1_000_000 }, price),
    ).toBeCloseTo(3 + 18.75);
  });
});

describe("deriveSessionUsage", () => {
  it("an untouched session has no sections and an idle pill", () => {
    const v = deriveSessionUsage(base);
    expect(v.headline).toBeNull();
    expect(v.tokens).toBeNull();
    expect(v.cost).toBeNull();
    expect(v.session).toBeNull();
    expect(v.pill).toMatchObject({ label: "Usage", state: "idle", ringFrac: null });
  });

  it("an ACP agent reporting only a context gauge gets a context headline and nothing else", () => {
    // What Codex over ACP looks like: `usage_update {used, size}`, no split.
    const v = deriveSessionUsage({ ...base, contextUsed: 84_200, contextSize: 200_000 });
    expect(v.headline).toMatchObject({
      kind: "context",
      used: 84_200,
      size: 200_000,
      status: "ok",
    });
    expect(v.tokens).toBeNull();
    expect(v.cost).toBeNull();
    expect(v.pill).toMatchObject({ label: "42%", state: "context", tint: "none" });
    expect(v.pill.ringFrac).toBeCloseTo(0.421);
    expect(v.pill.hint).toBe(contextUsageHint(84_200, 200_000, 42.1));
  });

  it("the pill tints amber at the warning band and red at the window", () => {
    expect(
      deriveSessionUsage({ ...base, contextUsed: 160_000, contextSize: 200_000 }).pill.tint,
    ).toBe("warn");
    expect(
      deriveSessionUsage({ ...base, contextUsed: 210_000, contextSize: 200_000 }).pill,
    ).toMatchObject({ tint: "error", label: "105%", ringFrac: 1 });
  });

  it("a split makes token rows, only for halves that are non-zero, sized to the largest", () => {
    const v = deriveSessionUsage({ ...base, input: 1_000, output: 250, cacheRead: 4_000 });
    expect(v.tokens?.map((r) => r.key)).toEqual(["input", "output", "cacheRead"]);
    expect(v.tokens?.find((r) => r.key === "cacheRead")?.frac).toBe(1);
    expect(v.tokens?.find((r) => r.key === "output")?.frac).toBeCloseTo(0.0625);
    // No context → the split is the headline, and the ring stays empty
    // (dashed) rather than inventing a proportion.
    expect(v.headline).toMatchObject({ kind: "tokens", total: 5_250 });
    expect(v.pill).toMatchObject({
      label: "5.3K",
      state: "tokens",
      ringFrac: null,
      hint: "Session usage — 5.3K tokens",
    });
  });

  it("estimates cost from the price map and says so; an unpriced model shows none", () => {
    const priced = deriveSessionUsage({ ...base, input: 1_000_000, output: 100_000, price });
    expect(priced.cost).toMatchObject({ total: 15 + 7.5, estimated: true });
    expect(priced.cost?.rows.map((r) => r.key)).toEqual(["input", "output"]);
    expect(priced.cost?.rows[0].cost).toBe(15);

    const unpriced = deriveSessionUsage({ ...base, input: 1_000_000, output: 100_000 });
    expect(unpriced.cost).toBeNull();
    expect(unpriced.tokens).not.toBeNull();
  });

  it("an agent-reported cost wins over the estimate and is not labelled estimated", () => {
    const v = deriveSessionUsage({ ...base, input: 10, output: 10, price, agentCost: 0.42 });
    expect(v.cost).toMatchObject({ total: 0.42, estimated: false });
  });

  it("reasoning is a row of its own but is never priced on its own", () => {
    const v = deriveSessionUsage({
      ...base,
      agentType: NATIVE_AGENT_ID,
      input: 100,
      output: 400,
      reasoning: 300,
      price,
    });
    const reasoning = v.tokens?.find((r) => r.key === "reasoning");
    expect(reasoning).toMatchObject({ value: 300, cost: null });
    expect(v.cost?.rows.map((r) => r.key)).toEqual(["input", "output"]);
  });

  it("falls back to the persisted split when the live one is empty", () => {
    // A reopened ACP session: the store has nothing until the next turn, but
    // capture remembers what the session spent.
    const v = deriveSessionUsage({
      ...base,
      summary: summary({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 9_000 }),
    });
    expect(v.tokens?.map((r) => [r.key, r.value])).toEqual([
      ["input", 500],
      ["output", 50],
      ["cacheRead", 9_000],
    ]);
  });

  it("the live split beats the record once it exists", () => {
    const v = deriveSessionUsage({
      ...base,
      input: 10,
      summary: summary({ inputTokens: 500 }),
    });
    expect(v.tokens).toEqual([expect.objectContaining({ key: "input", value: 10 })]);
  });

  it("the session card takes what the record knows and hides what it does not", () => {
    const v = deriveSessionUsage({
      ...base,
      turns: 3,
      messages: 7,
      summary: summary({
        messageCount: 8,
        toolCallCount: 12,
        filesTouched: 4,
        insertions: 40,
        deletions: 9,
        activeSeconds: 0,
        checkpointCount: 0,
      }),
    });
    expect(v.session).toEqual({
      turns: 3,
      messages: 8,
      toolCalls: 12,
      filesTouched: 4,
      insertions: 40,
      deletions: 9,
      activeSeconds: null,
      checkpoints: null,
    });
  });

  it("with no record, the session card still counts the live transcript", () => {
    const v = deriveSessionUsage({ ...base, turns: 2, messages: 4 });
    expect(v.session).toMatchObject({ turns: 2, messages: 4, toolCalls: null });
  });

  it("compacting overrides the pill", () => {
    const v = deriveSessionUsage({
      ...base,
      contextUsed: 100,
      contextSize: 200,
      compacting: true,
    });
    expect(v.pill).toMatchObject({
      label: "Compacting…",
      state: "compacting",
      ringFrac: 0.5,
    });
    expect(v.pill.hint).toContain("tokens used (50%)");
    expect(v.compacting).toBe(true);
  });

  it("an agent that never reports a window gets no ring fill", () => {
    const v = deriveSessionUsage({ ...base, contextUsed: 4_000, contextSize: 0 });
    expect(v.headline).toBeNull();
    expect(v.pill.ringFrac).toBeNull();
    expect(v.pill.state).toBe("idle");
  });

  it("a quota section exists only when a window was reported", () => {
    expect(
      deriveSessionUsage({
        ...base,
        rateLimits: { primary: null, secondary: null, planType: "plus" },
      }).quota,
    ).toBeNull();
    const v = deriveSessionUsage({
      ...base,
      rateLimits: {
        primary: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
        secondary: null,
        planType: "plus",
      },
    });
    expect(v.quota).toMatchObject({ plan: "plus", primary: { usedPercent: 40 } });
  });
});
