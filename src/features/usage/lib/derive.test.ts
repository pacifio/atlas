import { describe, expect, it } from "vitest";
import {
  EMPTY_AGENT_REGISTRY,
  resolveAgentMeta,
  type AgentMetaResolver,
} from "@/features/agents/lib/agent-identity";
import {
  agentDisplay,
  applyFacets,
  byokAsDaily,
  deltaPct,
  efficiency,
  facetsOf,
  insights,
  rankBy,
  rowsInRange,
  series,
  totalsOf,
  MAX_SERIES,
  OTHER_KEY,
} from "./derive";
import {
  BYOK_AGENT,
  NO_FACETS,
  UNKNOWN,
  type DailyBucket,
  type SessionRow,
  type UsageDashboard,
} from "../types";

const BYOK_PATH = "byok";

/** Agent identity over an empty registry: first-party names, prettified ids. */
const resolve: AgentMetaResolver = (id) => resolveAgentMeta(id, EMPTY_AGENT_REGISTRY);

function bucket(over: Partial<DailyBucket> = {}): DailyBucket {
  return {
    date: "2026-09-10",
    projectPath: "/w/atlas",
    agent: "claude-code",
    model: "claude-sonnet-4",
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 1,
    messages: 2,
    sessions: 1,
    ...over,
  };
}

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "s1",
    projectPath: "/w/atlas",
    agent: "claude-code",
    model: "claude-sonnet-4",
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    messages: 1,
    cost: 0.1,
    startedMs: 0,
    lastActivityMs: null,
    title: "t",
    ledgered: true,
    ...over,
  };
}

function dashboard(over: Partial<UsageDashboard> = {}): UsageDashboard {
  return {
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      cost: 0,
      messages: 0,
      sessions: 0,
      byokInput: 0,
      byokOutput: 0,
      byokCost: 0,
      byokRequests: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    },
    projects: [
      {
        projectPath: "/w/atlas",
        projectName: "Atlas",
        firstActivityMs: null,
        lastActivityMs: null,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        cost: 0,
        messages: 0,
        sessions: 0,
      },
    ],
    agents: [],
    models: [],
    daily: [],
    sessions: [],
    sessionsTotal: 0,
    byokDaily: [],
    byokSince: null,
    byokProjectPath: BYOK_PATH,
    ledgerSince: null,
    generatedAt: "2026-09-17T00:00:00Z",
    ...over,
  };
}

const color = (i: number) => `c${i}`;

describe("byokAsDaily", () => {
  it("maps BYOK days onto daily buckets under the pseudo project and agent", () => {
    const rows = byokAsDaily(
      [
        {
          date: "2026-09-01",
          provider: "openai",
          model: "gpt-5",
          input: 7,
          output: 3,
          cost: 0.5,
          requests: 4,
        },
      ],
      BYOK_PATH,
    );
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        projectPath: BYOK_PATH,
        agent: BYOK_AGENT,
        model: "openai/gpt-5",
        input: 7,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        cost: 0.5,
        messages: 4,
        sessions: 0,
      },
    ]);
  });
});

describe("rowsInRange / applyFacets / totalsOf", () => {
  const rows = [
    bucket({ date: "2026-09-01", agent: "claude-code", model: "a" }),
    bucket({ date: "2026-09-05", agent: "codex", model: "b", projectPath: "/w/other" }),
    bucket({ date: "2026-09-09", agent: "codex", model: "a" }),
  ];

  it("keeps rows inside the inclusive bounds", () => {
    expect(rowsInRange(rows, { from: "2026-09-05", to: "2026-09-09" }).map((r) => r.date)).toEqual([
      "2026-09-05",
      "2026-09-09",
    ]);
  });

  it("empty facets pass everything through (same array)", () => {
    expect(applyFacets(rows, NO_FACETS)).toBe(rows);
  });

  it("ANDs across axes, ORs within one", () => {
    const codex = applyFacets(rows, { ...NO_FACETS, agents: ["codex"] });
    expect(codex).toHaveLength(2);
    const codexA = applyFacets(rows, { ...NO_FACETS, agents: ["codex"], models: ["a"] });
    expect(codexA.map((r) => r.date)).toEqual(["2026-09-09"]);
    const both = applyFacets(rows, { ...NO_FACETS, models: ["a", "b"] });
    expect(both).toHaveLength(3);
  });

  it("totalsOf sums every additive field", () => {
    const t = totalsOf([
      bucket({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        reasoning: 5,
        cost: 6,
        messages: 7,
      }),
      bucket({
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        reasoning: 50,
        cost: 60,
        messages: 70,
      }),
    ]);
    expect(t).toMatchObject({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      reasoning: 55,
      cost: 66,
      messages: 77,
    });
  });
});

describe("facetsOf", () => {
  it("orders heaviest first and labels BYOK + known projects", () => {
    const data = dashboard();
    const rows = [
      bucket({ projectPath: "/w/atlas", input: 10, output: 0 }),
      bucket({
        projectPath: BYOK_PATH,
        agent: BYOK_AGENT,
        model: "openai/gpt-5",
        input: 500,
        output: 0,
      }),
      bucket({ projectPath: "/w/unknown-proj", input: 20, output: 0 }),
    ];
    const f = facetsOf(rows, data, resolve);
    expect(f.projects.map((p) => p.label)).toEqual(["BYOK chat", "unknown-proj", "Atlas"]);
    expect(f.projects[0]).toMatchObject({ value: BYOK_PATH, tokens: 500, rows: 1 });
    expect(f.agents.map((a) => a.label)).toEqual(["BYOK", expect.any(String)]);
    expect(f.agents[0].value).toBe(BYOK_AGENT);
    expect(f.models).toHaveLength(2);
  });
});

describe("agentDisplay", () => {
  it("names the BYOK and unknown buckets itself", () => {
    expect(agentDisplay(BYOK_AGENT, resolve)).toBe("BYOK");
    expect(agentDisplay(UNKNOWN, resolve)).toBe("Unknown agent");
  });

  it("keeps the first-party names", () => {
    expect(agentDisplay("claude-code", resolve)).toBe("Claude Code");
    expect(agentDisplay("codex", resolve)).toBe("Codex");
    expect(agentDisplay("atlas-agent", resolve)).toBe("Atlas");
  });

  it("names a registry agent through the resolver it is handed", () => {
    const registry: AgentMetaResolver = (id) =>
      resolveAgentMeta(id, {
        catalogById: {},
        registryEntries: [{ id: "gemini", name: "Gemini CLI", iconDataUrl: null }],
      });
    expect(agentDisplay("gemini", registry)).toBe("Gemini CLI");
    expect(agentDisplay("gemini", resolve)).toBe("Gemini");
    expect(rankBy([bucket({ agent: "gemini" })], "agent", "tokens", null, registry)[0].label).toBe(
      "Gemini CLI",
    );
  });
});

describe("rankBy", () => {
  it("shares sum to 1 and sorts descending", () => {
    const rows = [
      bucket({ agent: "a", input: 10, output: 0 }),
      bucket({ agent: "b", input: 30, output: 0 }),
      bucket({ agent: "a", input: 20, output: 0 }),
    ];
    const r = rankBy(rows, "agent", "tokens", null, resolve);
    expect(r.map((x) => x.key)).toEqual(["a", "b"]);
    expect(r.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
    expect(r[0].value).toBe(30);
  });

  it("shares are 0 when the metric total is 0", () => {
    const r = rankBy([bucket({ cost: 0 })], "project", "cost", null, resolve);
    expect(r[0].share).toBe(0);
  });
});

describe("series", () => {
  it("emits every day in the range, including empty ones", () => {
    const rows = [bucket({ date: "2026-09-02" }), bucket({ date: "2026-09-04" })];
    const s = series(
      rows,
      "agent",
      "tokens",
      { from: "2026-09-01", to: "2026-09-05" },
      null,
      color,
      "other",
      resolve,
    );
    expect(s.bucket).toBe("day");
    expect(s.columns.map((c) => c.date)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
    expect(s.columns.map((c) => c.total)).toEqual([0, 150, 0, 150, 0]);
    expect(s.max).toBe(150);
  });

  it("folds keys beyond the top 8 into Other", () => {
    const rows = Array.from({ length: MAX_SERIES + 3 }, (_, i) =>
      bucket({ agent: `agent-${i}`, input: 100 - i, output: 0 }),
    );
    const s = series(
      rows,
      "agent",
      "tokens",
      { from: "2026-09-10", to: "2026-09-10" },
      null,
      color,
      "other",
      resolve,
    );
    expect(s.keys).toHaveLength(MAX_SERIES + 1);
    const other = s.keys[s.keys.length - 1];
    expect(other).toEqual({ key: OTHER_KEY, label: "Other", color: "other" });
    const col = s.columns[0];
    // The three lightest keys (100-8, 100-9, 100-10) fold into Other.
    expect(col.values[MAX_SERIES]).toBe(92 + 91 + 90);
    expect(col.total).toBe(rows.reduce((n, r) => n + r.input, 0));
  });

  it("does not add Other when there are exactly 8 keys", () => {
    const rows = Array.from({ length: MAX_SERIES }, (_, i) => bucket({ agent: `agent-${i}` }));
    const s = series(
      rows,
      "agent",
      "tokens",
      { from: "2026-09-10", to: "2026-09-10" },
      null,
      color,
      "other",
      resolve,
    );
    expect(s.keys.some((k) => k.key === OTHER_KEY)).toBe(false);
  });

  it("buckets by week above 120 days, keyed on Mondays", () => {
    const rows = [bucket({ date: "2026-09-17" })];
    const s = series(
      rows,
      "agent",
      "tokens",
      { from: "2026-01-01", to: "2026-09-17" },
      null,
      color,
      "other",
      resolve,
    );
    expect(s.bucket).toBe("week");
    expect(s.columns[0].date).toBe("2025-12-29"); // Monday of the week containing Jan 1
    for (const c of s.columns) expect(new Date(c.date + "T00:00:00").getDay()).toBe(1);
    const hit = s.columns.find((c) => c.date === "2026-09-14");
    expect(hit?.total).toBe(150);
  });

  it("is empty for an unbounded range with no rows", () => {
    const s = series(
      [],
      "agent",
      "tokens",
      { from: null, to: "2026-09-17" },
      null,
      color,
      "other",
      resolve,
    );
    expect(s).toEqual({ bucket: "day", keys: [], columns: [], max: 0 });
  });
});

describe("efficiency / deltaPct", () => {
  it("computes the ratios", () => {
    const e = efficiency(
      {
        input: 100,
        output: 50,
        cacheRead: 300,
        cacheWrite: 100,
        reasoning: 0,
        cost: 2,
        messages: 4,
        sessions: 0,
      },
      2,
    );
    expect(e.cacheHitRate).toBeCloseTo(0.6);
    expect(e.outputPerInput).toBeCloseTo(0.5);
    expect(e.costPerSession).toBe(1);
    expect(e.costPerMessage).toBe(0.5);
    expect(e.tokensPerSession).toBe(75);
    expect(e.blendedCostPer1kOutput).toBeCloseTo(40);
  });

  it("is null on zero denominators", () => {
    const e = efficiency(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        cost: 0,
        messages: 0,
        sessions: 0,
      },
      0,
    );
    expect(e).toEqual({
      cacheHitRate: null,
      outputPerInput: null,
      costPerSession: null,
      costPerMessage: null,
      tokensPerSession: null,
      blendedCostPer1kOutput: null,
    });
  });

  it("deltaPct is null without a previous value", () => {
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(10, null)).toBeNull();
    expect(deltaPct(15, 10)).toBeCloseTo(0.5);
    expect(deltaPct(5, 10)).toBeCloseTo(-0.5);
  });
});

describe("insights", () => {
  const fmt = {
    fmtCost: (n: number) => `$${n}`,
    fmtTokens: (n: number) => `${n}`,
    resolveAgent: resolve,
  };

  it("has no cache rule when nothing came from cache", () => {
    const rows = [bucket({ cacheRead: 0 })];
    const out = insights({
      rows,
      totals: totalsOf(rows),
      prevTotals: null,
      sessions: [],
      data: null,
      ...fmt,
    });
    expect(out.find((i) => i.id === "cache")).toBeUndefined();
  });

  it("reports the cache share when there is one", () => {
    const rows = [bucket({ input: 100, cacheRead: 300, cacheWrite: 0 })];
    const out = insights({
      rows,
      totals: totalsOf(rows),
      prevTotals: null,
      sessions: [],
      data: null,
      ...fmt,
    });
    expect(out.find((i) => i.id === "cache")?.stat).toBe("75%");
  });

  it("counts unpriced sessions", () => {
    const rows = [bucket()];
    const sessions = [
      session({ sessionId: "a", cost: 0, input: 5 }),
      session({ sessionId: "b", cost: 0, input: 5 }),
      session({ sessionId: "c", cost: 1 }),
      session({ sessionId: "d", cost: 0, input: 0, output: 0 }), // empty, not "unpriced"
    ];
    const out = insights({
      rows,
      totals: totalsOf(rows),
      prevTotals: null,
      sessions,
      data: null,
      ...fmt,
    });
    const u = out.find((i) => i.id === "unpriced");
    expect(u?.stat).toBe("2");
    expect(u?.lead).toBe("sessions have no price");
  });

  it("period delta only appears from ±5%", () => {
    const rows = [bucket({ input: 100, output: 0 })];
    const totals = totalsOf(rows);
    const flat = insights({
      rows,
      totals,
      prevTotals: { ...totals, input: 98 },
      sessions: [],
      data: null,
      ...fmt,
    });
    expect(flat.find((i) => i.id === "period")).toBeUndefined();
    const up = insights({
      rows,
      totals,
      prevTotals: { ...totals, input: 50 },
      sessions: [],
      data: null,
      ...fmt,
    });
    expect(up.find((i) => i.id === "period")?.stat).toBe("+100%");
  });
});
