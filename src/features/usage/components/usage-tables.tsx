import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownWideNarrow, Search } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tryatlas/design";
import { Bar, EstTag, useMounted } from "@/components/usage-primitives";
import { AgentGlyph } from "@/components/brand-marks";
import { useAgentMetaResolver } from "@/features/agents/lib/agent-meta-context";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import {
  BYOK_AGENT,
  UNKNOWN,
  type GroupBy,
  type SessionRow,
  type TableTab,
  type UsageDashboard,
} from "../types";
import {
  agentDisplay,
  keyOf,
  modelDisplay,
  projectLabel,
  tokensOf,
  type RankedKey,
} from "../lib/derive";
import { useIdentityTints, useSeriesPalette } from "../lib/palette";

const ROW_H = 30;

// No icons. Four nouns that are already distinct words do not need four
// glyphs to tell them apart, and the row of them was the busiest thing in a
// header whose job is to be quiet.
const TABS: ReadonlyArray<{ id: TableTab; label: string }> = [
  { id: "sessions", label: "Sessions" },
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "models", label: "Models" },
];

type SortKey = "recent" | "cost" | "tokens" | "messages" | "cache";
const SORT_LABEL: Record<SortKey, string> = {
  recent: "Most recent",
  cost: "Highest cost",
  tokens: "Most tokens",
  messages: "Most messages",
  cache: "Most cache",
};

/**
 * The tables, chip-tabbed (the reference's underline tabs with an icon): Sessions is the
 * virtualized long list; Projects / Agents / Models are the rollups with share bars. One
 * toolbar — search and a sort menu — serves all four.
 */
export function UsageTables({
  tab,
  onTab,
  sessions,
  sessionsTotal,
  ranked,
  data,
  search,
  onSearch,
}: {
  tab: TableTab;
  onTab: (t: TableTab) => void;
  sessions: SessionRow[];
  /** Sessions in the org before the wire cap, so the footer can say when the list is cut. */
  sessionsTotal: number;
  ranked: Record<Exclude<TableTab, "sessions">, RankedKey[]>;
  data: UsageDashboard;
  search: string;
  onSearch: (q: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("recent");
  const counts: Record<TableTab, number> = {
    sessions: sessions.length,
    projects: ranked.projects.length,
    agents: ranked.agents.length,
    models: ranked.models.length,
  };
  return (
    <div className="flex flex-col rounded-lg border border-element-selected bg-card">
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-element-selected px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={cn(
              "-mb-px flex h-[36px] items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-b-primary text-foreground"
                : "border-b-transparent text-secondary-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {/* The neutral overlay ramp, at its pressed and hover steps — the
                two ends of `element.*`, so a light theme gets a dark wash
                rather than the white one a literal would keep. */}
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-3xs tabular-nums transition-colors",
                tab === t.id
                  ? "bg-element-active text-secondary-foreground"
                  : "bg-element-hover text-muted-foreground",
              )}
            >
              {fmtNum(counts[t.id])}
            </span>
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex h-control-md w-[200px] items-center gap-1.5 rounded-md border border-border bg-background px-2 focus-within:border-border-strong">
          <Search size={11} className="shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={tab === "sessions" ? "Search sessions" : "Filter rows"}
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="md" title="Sort">
                <ArrowDownWideNarrow size={12} className="text-muted-foreground" />
                {SORT_LABEL[sort]}
              </Button>
            }
          />
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-[160px]">
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <DropdownMenuRadioItem
                  key={k}
                  value={k}
                  // Base UI leaves a marked item's menu open; Radix's
                  // `RadioItem` closed it, and picking one sort order is a
                  // one-shot choice, so the old behaviour is restored.
                  closeOnClick
                >
                  {SORT_LABEL[k]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {tab === "sessions" ? (
        <SessionsTable rows={sessions} sort={sort} data={data} sessionsTotal={sessionsTotal} />
      ) : (
        <RollupTable
          rows={ranked[tab]}
          sort={sort}
          axis={tab === "projects" ? "project" : tab === "agents" ? "agent" : "model"}
          search={search}
          sessions={sessions}
        />
      )}
    </div>
  );
}

// ── Sessions ───────────────────────────────────────────────────────────────

const COL = {
  title: "flex-1 min-w-[180px]",
  project: "w-[120px] shrink-0",
  agent: "w-[110px] shrink-0",
  model: "w-[120px] shrink-0",
  tokens: "w-[72px] shrink-0 text-right",
  cache: "w-[72px] shrink-0 text-right",
  cost: "w-[80px] shrink-0 text-right",
  when: "w-[84px] shrink-0 text-right",
} as const;

function sortSessions(rows: SessionRow[], sort: SortKey): SessionRow[] {
  const by: Record<SortKey, (a: SessionRow, b: SessionRow) => number> = {
    recent: (a, b) => (b.lastActivityMs ?? b.startedMs) - (a.lastActivityMs ?? a.startedMs),
    cost: (a, b) => b.cost - a.cost,
    tokens: (a, b) => tokensOf(b) - tokensOf(a),
    messages: (a, b) => b.messages - a.messages,
    cache: (a, b) => b.cacheRead + b.cacheWrite - (a.cacheRead + a.cacheWrite),
  };
  return [...rows].sort(by[sort]);
}

function SessionsTable({
  rows,
  sort,
  data,
  sessionsTotal,
}: {
  rows: SessionRow[];
  sort: SortKey;
  data: UsageDashboard;
  sessionsTotal: number;
}) {
  const sorted = useMemo(() => sortSessions(rows, sort), [rows, sort]);
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => sorted[i]?.sessionId ?? String(i),
  });
  const capped = data.sessions.length < sessionsTotal;
  return (
    <>
      <div className="flex h-control-md shrink-0 items-center border-b border-element-selected px-3 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={COL.title}>Session</span>
        <span className={COL.project}>Project</span>
        <span className={COL.agent}>Agent</span>
        <span className={COL.model}>Model</span>
        <span className={COL.tokens}>Tokens</span>
        <span className={COL.cache}>Cache</span>
        <span className={cn(COL.cost, "inline-flex items-center justify-end gap-1")}>
          Cost <EstTag />
        </span>
        <span className={COL.when}>Last active</span>
      </div>
      <div ref={parentRef} className="hide-scrollbar h-[420px] overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">No sessions match.</div>
        ) : (
          <div className="relative w-full" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((item) => {
              const s = sorted[item.index];
              return (
                <div
                  key={item.key}
                  className="absolute left-0 top-0 flex w-full items-center border-b border-border-subtle px-3 text-xs hover:bg-element-hover"
                  style={{ height: ROW_H, transform: `translateY(${item.start}px)` }}
                >
                  <span className={cn(COL.title, "flex min-w-0 items-center gap-2 pr-3")}>
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        s.ledgered ? "bg-success" : "bg-disabled",
                      )}
                      title={s.ledgered ? "Dated per turn" : "Dated to its last-active day"}
                    />
                    <span className="truncate text-foreground" title={s.title || s.sessionId}>
                      {s.title || (
                        <span className="text-muted-foreground">
                          Untitled · {s.sessionId.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={cn(COL.project, "truncate pr-2 text-secondary-foreground")}>
                    {projectLabel(s.projectPath, data)}
                  </span>
                  <span className={cn(COL.agent, "pr-2")}>
                    <AgentChip agent={s.agent} />
                  </span>
                  <span className={cn(COL.model, "pr-2")}>
                    <ModelChip model={s.model} />
                  </span>
                  <span className={cn(COL.tokens, "tabular-nums text-foreground")}>
                    {fmtTokens(tokensOf(s))}
                  </span>
                  <span className={cn(COL.cache, "tabular-nums text-secondary-foreground")}>
                    {fmtTokens(s.cacheRead + s.cacheWrite)}
                  </span>
                  <span className={cn(COL.cost, "tabular-nums text-foreground")}>
                    {s.cost > 0 ? (
                      fmtCost(s.cost)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className={cn(COL.when, "tabular-nums text-muted-foreground")}>
                    {timeAgo(new Date(s.lastActivityMs ?? s.startedMs).toISOString())}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {capped && (
        <div className="flex h-control-md shrink-0 items-center border-t border-element-selected px-3 text-2xs text-muted-foreground">
          Showing the {fmtNum(data.sessions.length)} most recent of {fmtNum(sessionsTotal)}{" "}
          sessions.
        </div>
      )}
    </>
  );
}

// ── Rollups ────────────────────────────────────────────────────────────────

function RollupTable({
  rows,
  sort,
  axis,
  search,
  sessions,
}: {
  rows: RankedKey[];
  sort: SortKey;
  axis: GroupBy;
  search: string;
  /** Facet-filtered sessions in range — the wire `sessions` field is per-bucket distinct and
   *  cannot be summed across days, so rollups count sessions from the rows themselves. */
  sessions: SessionRow[];
}) {
  const mounted = useMounted();
  const { seriesColor } = useSeriesPalette();
  const sessionsByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      const k = keyOf(s, axis);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [sessions, axis]);
  const q = search.trim().toLowerCase();
  const list = useMemo(() => {
    const filtered = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
    const key = (r: RankedKey) =>
      sort === "cost"
        ? r.metrics.cost
        : sort === "messages"
          ? r.metrics.messages
          : sort === "cache"
            ? r.metrics.cacheRead + r.metrics.cacheWrite
            : tokensOf(r.metrics);
    return sort === "recent" ? filtered : [...filtered].sort((a, b) => key(b) - key(a));
  }, [rows, sort, q]);
  const top = list.reduce((m, r) => Math.max(m, tokensOf(r.metrics)), 0);
  return (
    <>
      <div className="flex h-control-md shrink-0 items-center border-b border-element-selected px-3 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="min-w-[160px] flex-1">{axis}</span>
        <span className="w-[160px] shrink-0">Share</span>
        <span className="w-[72px] shrink-0 text-right">Tokens</span>
        <span className="w-[72px] shrink-0 text-right">Cache</span>
        <span className="w-[72px] shrink-0 text-right">Messages</span>
        <span className="w-[72px] shrink-0 text-right">Sessions</span>
        <span className="inline-flex w-[80px] shrink-0 items-center justify-end gap-1 text-right">
          Cost <EstTag />
        </span>
      </div>
      <div className="hide-scrollbar max-h-[420px] overflow-y-auto">
        {list.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground">Nothing matches.</div>
        )}
        {list.map((r, i) => (
          <div
            key={r.key}
            className="flex h-[30px] items-center border-b border-border-subtle px-3 text-xs hover:bg-element-hover"
          >
            <span className="flex min-w-[160px] flex-1 items-center gap-2 truncate pr-3">
              {axis === "agent" ? (
                <AgentChip agent={r.key} />
              ) : (
                <span className="truncate text-foreground" title={r.label}>
                  {r.label}
                </span>
              )}
            </span>
            <span className="flex w-[160px] shrink-0 items-center gap-2 pr-3">
              <span className="min-w-0 flex-1">
                <Bar
                  frac={top > 0 ? tokensOf(r.metrics) / top : 0}
                  mounted={mounted}
                  color={seriesColor(i)}
                />
              </span>
              <span className="w-[34px] text-right text-2xs tabular-nums text-muted-foreground">
                {fmtPct(r.share)}
              </span>
            </span>
            <span className="w-[72px] shrink-0 text-right tabular-nums text-foreground">
              {fmtTokens(tokensOf(r.metrics))}
            </span>
            <span className="w-[72px] shrink-0 text-right tabular-nums text-secondary-foreground">
              {fmtTokens(r.metrics.cacheRead + r.metrics.cacheWrite)}
            </span>
            <span className="w-[72px] shrink-0 text-right tabular-nums text-secondary-foreground">
              {fmtNum(r.metrics.messages)}
            </span>
            <span className="w-[72px] shrink-0 text-right tabular-nums text-secondary-foreground">
              {fmtNum(sessionsByKey.get(r.key) ?? 0)}
            </span>
            <span className="w-[80px] shrink-0 text-right tabular-nums text-foreground">
              {r.metrics.cost > 0 ? fmtCost(r.metrics.cost) : "—"}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Chips ──────────────────────────────────────────────────────────────────

/**
 * The agent: its brand mark, then its name. No chip.
 *
 * It used to be a pill wrapping an `.amark` badge wrapping the glyph — three
 * nested containers for one word, in a table that already has a column headed
 * AGENT. A row's job is to be scannable, and a box per cell is the opposite.
 *
 * The vendor tint stops at the glyph. The brand icons paint in `currentColor`,
 * so colouring the row's wrapper carried the tint into the NAME as well, and a
 * column of terracotta words read as a column of links. The mark is where a
 * brand colour belongs; the word beside it is body text and takes the theme's
 * own foreground, whatever the theme says that is.
 */
export function AgentChip({ agent }: { agent: string }) {
  const { agentTint } = useIdentityTints();
  const resolveAgent = useAgentMetaResolver();
  if (agent === BYOK_AGENT || agent === UNKNOWN)
    return (
      <span className="truncate text-muted-foreground">{agentDisplay(agent, resolveAgent)}</span>
    );
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-foreground">
      <span className="flex shrink-0 items-center" style={{ color: agentTint(agent).fg }}>
        <AgentGlyph agentType={agent} />
      </span>
      <span className="truncate">{agentDisplay(agent, resolveAgent)}</span>
    </span>
  );
}

/**
 * The model, tinted by the vendor it belongs to.
 *
 * A grey chip per row told you a model existed and nothing else; with a tint
 * you can see at a glance that a window was mostly Claude, or that one project
 * is the only thing still on a local model. Families, not individual models —
 * a colour per model id would be a new hue every release.
 */
function ModelChip({ model }: { model: string }) {
  const { modelTint } = useIdentityTints();
  const label = modelDisplay(model);
  if (model === UNKNOWN) return <span className="truncate text-muted-foreground">{label}</span>;
  // The vendor tint, on the text itself. No pill: the agent cell beside it is
  // already a bare glyph and name, and a box around one of the two made the
  // MODEL column read as the interactive one in a table where nothing is.
  return (
    <span className="truncate" style={{ color: modelTint(model).fg }}>
      {label}
    </span>
  );
}
