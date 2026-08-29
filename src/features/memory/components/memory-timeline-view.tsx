import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader2, RotateCw, GitBranch, Search, X, ArrowUp } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useMemoryStore } from "../stores/memory-store";
import { MemoryTimelineCalendar } from "./memory-timeline-calendar";
import { MemoryTimelinePanel, type PanelItem } from "./memory-timeline-panel";
import { memoryGraph } from "../lib/memory-graph-api";
import type { MemoryTimeline, TimelineCommit, TimelineMemory } from "../lib/memory-timeline-api";
import {
  loadMemoryTimelineDayCount,
  saveMemoryTimelineDayCount,
  type MemoryTimelineDayCount,
} from "./memory-timeline-view-prefs";

// ── Influence chain over the timeline (memory → session → commit) ──
function buildChain(t: MemoryTimeline) {
  const commitBySha = new Map(t.commits.map((c) => [c.sha, c] as const));
  const sessionsByTime = [...t.sessions].sort((a, b) => a.ts_ms - b.ts_ms);
  const memToSession = new Map<string, string>();
  for (const m of t.memory) {
    const s = sessionsByTime.find((x) => x.ts_ms >= m.ts_ms);
    if (s) memToSession.set(m.id, s.id);
  }
  const commitsByBranch = new Map<string, TimelineCommit[]>();
  for (const c of t.commits) {
    const a = commitsByBranch.get(c.branch) ?? [];
    a.push(c);
    commitsByBranch.set(c.branch, a);
  }
  for (const a of commitsByBranch.values()) a.sort((x, y) => x.ts_ms - y.ts_ms);
  const sessionToCommit = new Map<string, string>();
  for (const s of t.sessions) {
    if (s.sha && commitBySha.has(s.sha)) sessionToCommit.set(s.id, s.sha);
    else if (s.branch) {
      const nx = commitsByBranch.get(s.branch)?.find((c) => c.ts_ms >= s.ts_ms);
      if (nx) sessionToCommit.set(s.id, nx.sha);
    }
  }
  const commitToSessions = new Map<string, string[]>();
  for (const [sid, sha] of sessionToCommit) {
    const a = commitToSessions.get(sha) ?? [];
    a.push(sid);
    commitToSessions.set(sha, a);
  }
  const sessionToMems = new Map<string, string[]>();
  for (const [mid, sid] of memToSession) {
    const a = sessionToMems.get(sid) ?? [];
    a.push(mid);
    sessionToMems.set(sid, a);
  }
  return {
    commitBySha,
    memToSession,
    sessionToCommit,
    commitToSessions,
    sessionToMems,
    memById: new Map(t.memory.map((m) => [m.id, m] as const)),
    sessionById: new Map(t.sessions.map((s) => [s.id, s] as const)),
  };
}
type Chain = ReturnType<typeof buildChain>;

function affectingItems(selectedId: string, chain: Chain, t: MemoryTimeline): PanelItem[] {
  const notes = new Map<string, string>();
  const add = (mid: string, note: string) => {
    if (!notes.has(mid)) notes.set(mid, note);
  };
  if (selectedId.startsWith("commit:")) {
    const sha = selectedId.slice(7);
    for (const sid of chain.commitToSessions.get(sha) ?? [])
      for (const mid of chain.sessionToMems.get(sid) ?? [])
        add(mid, `fed a run → ${sha.slice(0, 7)}`);
  } else if (selectedId.startsWith("session:")) {
    for (const mid of chain.sessionToMems.get(selectedId.slice(8)) ?? []) add(mid, "fed this run");
  } else if (selectedId.startsWith("branch:")) {
    const br = selectedId.slice(7);
    for (const s of t.sessions)
      if (s.branch === br)
        for (const mid of chain.sessionToMems.get(s.id) ?? []) add(mid, `fed a run on ${br}`);
  }
  return [...notes.entries()]
    .map(([mid, note]) => {
      const m = chain.memById.get(mid) as TimelineMemory;
      return {
        id: mid,
        title: m.title,
        source: m.source,
        note,
        ts_ms: m.ts_ms,
      };
    })
    .sort((a, b) => b.ts_ms - a.ts_ms);
}

export function MemoryTimelineView() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const isRepo = useGitStore.use.isRepo();
  const timeline = useMemoryStore.use.timeline();
  const loading = useMemoryStore.use.timelineLoading();
  const { ensureProject, loadTimeline } = useMemoryStore.use.actions();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchItems, setSearchItems] = useState<PanelItem[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<Set<string> | null>(null);

  // Day-range columns; 4 by default, user-selectable via the header toggle.
  const [dayCount, setDayCount] = useState<MemoryTimelineDayCount>(loadMemoryTimelineDayCount);
  const setPersistedDayCount = (nextDayCount: MemoryTimelineDayCount) => {
    setDayCount(nextDayCount);
    saveMemoryTimelineDayCount(nextDayCount);
  };

  useEffect(() => {
    ensureProject(projectPath);
    if (projectPath && isRepo) void loadTimeline(projectPath);
  }, [projectPath, isRepo, ensureProject, loadTimeline]);

  const chain = useMemo(() => (timeline ? buildChain(timeline) : null), [timeline]);

  // Card ids (commit/session) that have memory feeding into them via the chain.
  const memoryIds = useMemo(() => {
    if (!timeline || !chain) return null;
    const s = new Set<string>();
    for (const ses of timeline.sessions)
      if ((chain.sessionToMems.get(ses.id)?.length ?? 0) > 0) s.add(`session:${ses.id}`);
    for (const c of timeline.commits) {
      const sids = chain.commitToSessions.get(c.sha) ?? [];
      if (sids.some((sid) => (chain.sessionToMems.get(sid)?.length ?? 0) > 0))
        s.add(`commit:${c.sha}`);
    }
    return s;
  }, [timeline, chain]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || !projectPath || !chain || !timeline) return;
    setSearching(true);
    setSearchError(null);
    setSelectedId(null);
    try {
      const hits = await memoryGraph.query(projectPath, q, 20);
      const hi = new Set<string>();
      const items: PanelItem[] = [];
      for (const h of hits) {
        const m = chain.memById.get(h.id);
        if (!m) continue;
        const sid = chain.memToSession.get(h.id);
        let note = "no linked commit";
        if (sid) {
          hi.add(`session:${sid}`);
          const sha = chain.sessionToCommit.get(sid);
          if (sha) {
            hi.add(`commit:${sha}`);
            note = `impacts ${sha.slice(0, 7)} on ${chain.commitBySha.get(sha)?.branch ?? "?"}`;
          } else note = "linked to a run";
        }
        items.push({
          id: h.id,
          title: m.title,
          source: m.source,
          note,
          ts_ms: m.ts_ms,
          score: h.score,
        });
      }
      setHighlightIds(hi);
      setSearchItems(items);
      if (items.length === 0)
        setSearchError(
          "No indexed memory matched. Build the Graph tab first if results look empty.",
        );
    } catch (e) {
      const msg = String(e);
      setSearchError(
        msg.includes("model-not-downloaded")
          ? "Download the embedding model (Graph tab) to search."
          : "Search failed.",
      );
      setSearchItems([]);
      setHighlightIds(null);
    } finally {
      setSearching(false);
    }
  }, [query, projectPath, chain, timeline]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setSearchItems(null);
    setSearchError(null);
    setHighlightIds(null);
  }, []);

  // ── Gates ──
  if (!projectPath) return <Centered>Open a project first.</Centered>;
  if (!isRepo) {
    return (
      <Centered>
        <div className="text-center max-w-[320px] px-6 space-y-2">
          <GitBranch size={22} className="text-[var(--text-tertiary)] mx-auto" />
          <p className="text-[12px] text-[var(--text-secondary)]">Timeline needs a git repo</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            Initialize git to map agent sessions and memory onto branch lanes over time.
          </p>
        </div>
      </Centered>
    );
  }
  if (loading && !timeline) {
    return (
      <Centered>
        <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
      </Centered>
    );
  }
  if (!timeline || !chain) {
    return (
      <Centered>
        <div className="text-center space-y-2">
          <p className="text-[12px] text-[var(--text-tertiary)]">Couldn't build the timeline.</p>
          <button
            onClick={() => projectPath && void loadTimeline(projectPath, true)}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <RotateCw size={12} /> Retry
          </button>
        </div>
      </Centered>
    );
  }

  // Panel mode: search results, else selection-affecting memory.
  const searchMode = searchItems !== null;
  const panelOpen = searchMode || selectedId !== null;
  const panelItems = searchMode
    ? searchItems
    : selectedId
      ? affectingItems(selectedId, chain, timeline)
      : [];
  const panelTitle = searchMode
    ? `Impact of “${query.trim()}”`
    : selectionTitle(selectedId, timeline);
  const panelSubtitle = searchMode
    ? (searchError ?? `${searchItems!.length} memories · ${highlightIds?.size ?? 0} git targets`)
    : "memory affecting this, newest first";

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)]">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Timeline</span>
        <span className="tabular-nums">
          {timeline.branches.length} branches · {timeline.commits.length} commits ·{" "}
          {timeline.sessions.length} sessions
        </span>
        <div className="flex-1" />
        {/* Day-range segmented toggle (auto via breakpoint, user-overridable). */}
        <div className="flex items-center rounded-md border border-[var(--border-default)] overflow-hidden h-6">
          {([3, 4, 7] as const).map((n) => (
            <button
              key={n}
              onClick={() => setPersistedDayCount(n)}
              className={cn(
                "px-2 h-6 text-[10px] tabular-nums transition-colors cursor-pointer border-l border-[var(--border-default)] first:border-l-0",
                dayCount === n
                  ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
              )}
              title={`Show ${n} days`}
            >
              {n}d
            </button>
          ))}
        </div>
        <button
          onClick={() => projectPath && void loadTimeline(projectPath, true)}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Refresh"
          aria-label="Refresh"
        >
          <RotateCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Chart + panel + tooltip */}
      <div className="flex-1 min-h-0 relative">
        <MemoryTimelineCalendar
          data={timeline}
          selectedId={selectedId}
          highlightIds={highlightIds}
          memoryIds={memoryIds}
          dayCount={dayCount}
          onSelect={(id) => {
            setSelectedId(id);
            if (id) clearSearch();
          }}
        />
        <MemoryTimelinePanel
          open={panelOpen}
          title={panelTitle}
          subtitle={panelSubtitle}
          items={panelItems}
          onClose={() => {
            setSelectedId(null);
            clearSearch();
          }}
        />

        {/* Floating semantic search pill — overlaid on the chart, no box. */}
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 w-[min(620px,calc(100%-40px))]">
          <div className="flex items-center gap-2.5 h-11 rounded-full bg-[#141414]/95 backdrop-blur-2xl shadow-[0_10px_40px_rgba(0,0,0,0.6)] border border-white/[0.12] px-4">
            <Search size={15} className="text-[var(--text-tertiary)] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
                else if (e.key === "Escape") clearSearch();
              }}
              placeholder="Ask how memory shaped your branches…"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
            {(query || searchMode) && !searching && (
              <button
                onClick={clearSearch}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] shrink-0"
                title="Clear"
              >
                <X size={15} />
              </button>
            )}
            <button
              onClick={() => void runSearch()}
              disabled={!query.trim() || searching}
              className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--accent-primary)] text-[var(--bg-base)] shrink-0 disabled:opacity-30 hover:opacity-90 transition-opacity cursor-pointer"
              title="Search memory impact"
            >
              {searching ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function selectionTitle(selectedId: string | null, t: MemoryTimeline): string {
  if (!selectedId) return "";
  if (selectedId.startsWith("commit:")) {
    const sha = selectedId.slice(7);
    const c = t.commits.find((x) => x.sha === sha);
    return c ? `Commit ${c.short} · ${c.branch}` : "Commit";
  }
  if (selectedId.startsWith("session:")) {
    const s = t.sessions.find((x) => x.id === selectedId.slice(8));
    return s ? `Run · ${s.branch ?? s.agent}` : "Run";
  }
  if (selectedId.startsWith("branch:")) return `Branch ${selectedId.slice(7)}`;
  return "";
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--text-tertiary)] text-[12px]">
      {children}
    </div>
  );
}
