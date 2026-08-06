import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  RefreshCw,
  FileText,
  BookText,
  Search,
  ChevronRight,
  ChevronDown,
  Coins,
  GitBranch,
  Clock,
  ShieldCheck,
  Cpu,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Check,
} from "lucide-react";
import { MemoryGraphView } from "./memory-graph-view";
import { MemoryPolicyView } from "./memory-policy-view";
import { MemoryTimelineView } from "./memory-timeline-view";
import { MemoryChatView } from "./memory-chat-view";
import { MemorySharingControls } from "./memory-sharing-controls";
import { SharedMemoryView } from "./shared-memory-view";
import { AtlasMemoryView } from "./atlas-memory-view";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { Markdown } from "@/lib/markdown";
import { timeAgo } from "@/lib/time-ago";
import { ClaudeIcon, CodexIcon, OpenCodeIcon, CursorIcon, KiloIcon } from "@/components/agent-icons";
import { CaptureSessionsView } from "./capture-sessions-view";
import { AtlasIcon } from "@/components/atlas-icon";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useMemoryStore } from "../stores/memory-store";
import type { ClaudeMemory, CodexMemory, CodexThread } from "../lib/memory-types";

// ── Panel shell ─────────────────────────────────────────────────────────────

export function MemoryPanel() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const sub = useMemoryStore.use.subTab();
  const data = useMemoryStore.use.agentMemory();
  const loading = useMemoryStore.use.agentMemoryLoading();
  const { setSubTab, ensureProject, loadAgentMemory } = useMemoryStore.use.actions();
  const setSub = setSubTab;

  // Cached: only fetches on first load / project change. Switching sub-tabs or
  // leaving and returning to the Memory tab renders the cached data instantly.
  useEffect(() => {
    ensureProject(projectPath);
    if (projectPath) void loadAgentMemory(projectPath);
  }, [projectPath, ensureProject, loadAgentMemory]);

  const load = () => {
    if (projectPath) void loadAgentMemory(projectPath, true);
  };

  const codexCount = data?.codex.threads.length ?? 0;
  const claudeCount =
    (data?.claude.entries.length ?? 0) +
    (data?.claude.index ? 1 : 0) +
    (data?.claude.project_md ? 1 : 0) +
    (data?.claude.global_md ? 1 : 0);

  // Native Atlas-agent session count for the agent picker pill (its sessions
  // live in a separate store, not the `agent_memory_read` blob).
  const [cerseiCount, setCerseiCount] = useState(0);
  useEffect(() => {
    if (!projectPath) {
      setCerseiCount(0);
      return;
    }
    invoke<unknown[]>("cersei_list_sessions", { projectPath })
      .then((s) => setCerseiCount(s.length))
      .catch(() => setCerseiCount(0));
  }, [projectPath, sub]);

  // Capture-backed agents (OpenCode / Cursor / Kilo) — their sessions live in
  // Atlas's own capture store; one GROUP BY gives all the badge counts.
  const [captureCounts, setCaptureCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!projectPath) {
      setCaptureCounts({});
      return;
    }
    invoke<Record<string, number>>("capture_agent_session_counts", { projectPath })
      .then(setCaptureCounts)
      .catch(() => setCaptureCounts({}));
  }, [projectPath, sub]);

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Header: Chat (left) · combined nav (absolute center) · refresh (right) */}
      <div className="relative flex items-center h-[32px] shrink-0 border-b border-[var(--border-default)] px-2">
        <div className="flex items-center">
          <PillSeg
            active={sub === "chat"}
            onClick={() => setSub("chat")}
            icon={<Sparkles size={12} />}
            label="Chat"
          />
        </div>

        {/* The -translate centering creates a stacking context that would trap
            the agent dropdown below the tables' sticky headers — lift it so the
            dropdown (and its own z-max) paint above the panel body. */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[var(--z-max)]">
          <PillGroup>
            <PillSeg
              active={sub === "graph"}
              onClick={() => setSub("graph")}
              icon={<Share2 size={12} />}
              label="Graph"
            />
            <PillSeg
              active={sub === "policy"}
              onClick={() => setSub("policy")}
              icon={<SlidersHorizontal size={12} />}
              label="Policy"
            />
            <PillSeg
              active={sub === "timeline"}
              onClick={() => setSub("timeline")}
              icon={<GitBranch size={12} />}
              label="Timeline"
            />
            <PillSeg
              active={sub === "shared"}
              onClick={() => setSub("shared")}
              icon={<Share2 size={12} />}
              label="Shared"
            />
            <div className="mx-0.5 h-3.5 w-px bg-[var(--border-default)]" />
            <CodingAgentMenu
              sub={sub}
              setSub={setSub}
              claudeCount={claudeCount}
              codexCount={codexCount}
              cerseiCount={cerseiCount}
              captureCounts={captureCounts}
            />
          </PillGroup>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <MemorySharingControls projectPath={projectPath} />
          <button
            onClick={load}
            className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {sub === "chat" ? (
          <MemoryChatView />
        ) : sub === "graph" ? (
          <MemoryGraphView />
        ) : sub === "policy" ? (
          <MemoryPolicyView />
        ) : sub === "timeline" ? (
          <MemoryTimelineView />
        ) : sub === "shared" ? (
          projectPath ? (
            <SharedMemoryView projectPath={projectPath} />
          ) : (
            <Centered>
              <p className="text-[12px] text-[var(--text-tertiary)]">
                Open a project to view shared memory.
              </p>
            </Centered>
          )
        ) : sub === "cersei" ? (
          <AtlasMemoryView projectPath={projectPath} />
        ) : sub === "opencode" || sub === "cursor" || sub === "kilo" ? (
          <CaptureSessionsView projectPath={projectPath} agent={sub} />
        ) : loading && !data ? (
          <PanelSkeleton rows={8} />
        ) : !projectPath ? (
          <Centered>
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Open a project to view agent memory.
            </p>
          </Centered>
        ) : sub === "claude" ? (
          <ClaudeView claude={data?.claude ?? null} />
        ) : (
          <CodexView codex={data?.codex ?? null} />
        )}
      </div>
    </div>
  );
}

/** Rounded container that groups segmented pills (the center nav + agent group). */
function PillGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-secondary))] p-0.5">
      {children}
    </div>
  );
}

/** One rounded segment; the active one renders as a filled pill. */
function PillSeg({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
        active
          ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
      )}
    >
      <span className={cn(active ? "opacity-100" : "opacity-60")}>{icon}</span>
      {label}
      {count !== undefined && count > 0 && (
        <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">{count}</span>
      )}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center">{children}</div>;
}

// ── Coding-agent combobox ────────────────────────────────────────────────────

type AgentSub = "claude" | "codex" | "cersei" | "opencode" | "cursor" | "kilo";

const AGENT_SUBS: readonly AgentSub[] = [
  "claude",
  "codex",
  "cersei",
  "opencode",
  "cursor",
  "kilo",
];

interface CodingAgentOption {
  sub: AgentSub;
  label: string;
  icon: React.ReactNode;
  count: number;
}

/** Searchable combobox that collapses the per-agent memory tabs (Claude Code,
 *  Codex, and future agents) into ONE pill, keeping the center nav compact as
 *  more agents are supported. The pill shows the active (or last-selected)
 *  agent; the dropdown filters by name and switches the memory sub-tab. */
function CodingAgentMenu({
  sub,
  setSub,
  claudeCount,
  codexCount,
  cerseiCount,
  captureCounts,
}: {
  sub: string;
  setSub: (s: AgentSub) => void;
  claudeCount: number;
  codexCount: number;
  cerseiCount: number;
  /** Per-plugin-id session counts from the capture store (opencode/cursor/kilo). */
  captureCounts: Record<string, number>;
}) {
  const options = useMemo<CodingAgentOption[]>(
    () => [
      { sub: "cersei", label: "Atlas", icon: <AtlasIcon size={14} />, count: cerseiCount },
      { sub: "claude", label: "Claude Code", icon: <ClaudeIcon className="size-3.5" />, count: claudeCount },
      { sub: "codex", label: "Codex", icon: <CodexIcon className="size-3.5" />, count: codexCount },
      { sub: "opencode", label: "OpenCode", icon: <OpenCodeIcon className="size-3.5" />, count: captureCounts["opencode"] ?? 0 },
      { sub: "cursor", label: "Cursor", icon: <CursorIcon className="size-3.5" />, count: captureCounts["cursor"] ?? 0 },
      { sub: "kilo", label: "Kilo", icon: <KiloIcon className="size-3.5" />, count: captureCounts["kilo"] ?? 0 },
    ],
    [claudeCount, codexCount, cerseiCount, captureCounts],
  );

  const isAgentActive = AGENT_SUBS.includes(sub as AgentSub);
  // Remember the last agent so the pill keeps its identity while the user is on
  // a non-agent tab (Graph/Policy/…).
  const [lastAgent, setLastAgent] = useState<AgentSub>(
    isAgentActive ? (sub as AgentSub) : "claude",
  );
  useEffect(() => {
    if (isAgentActive) setLastAgent(sub as AgentSub);
  }, [sub, isAgentActive]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const selected = options.find((o) => o.sub === lastAgent) ?? options[0];
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const choose = (s: AgentSub) => {
    setSub(s);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
          isAgentActive
            ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
        )}
        title="Coding agents"
      >
        <span className={cn(isAgentActive ? "opacity-100" : "opacity-60")}>{selected.icon}</span>
        {selected.label}
        {selected.count > 0 && (
          <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">{selected.count}</span>
        )}
        <ChevronDown
          size={11}
          className={cn("opacity-50 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 z-[var(--z-max)] min-w-[210px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-secondary))] p-1 shadow-lg">
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <Search size={11} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="w-full bg-transparent text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            />
          </div>
          <div className="mb-1 h-px bg-[var(--border-default)]" />
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-[10px] text-[var(--text-tertiary)]">No agents found</div>
          ) : (
            filtered.map((o) => {
              const active = sub === o.sub;
              return (
                <button
                  key={o.sub}
                  onClick={() => choose(o.sub)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    active
                      ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <span className="shrink-0">{o.icon}</span>
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                  {o.count > 0 && (
                    <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">
                      {o.count}
                    </span>
                  )}
                  {active && <Check size={11} className="shrink-0 text-[var(--accent-primary)]" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Claude: markdown master-detail ──────────────────────────────────────────

interface ClaudeItem {
  id: string;
  title: string;
  subtitle: string;
  badge: string | null;
  body: string;
  section: "Instructions" | "Index" | "Memories";
}

const KIND_TINT: Record<string, string> = {
  user: "var(--status-info)",
  feedback: "var(--status-warning)",
  project: "var(--accent-primary)",
  reference: "var(--text-tertiary)",
};

function ClaudeView({ claude }: { claude: ClaudeMemory | null }) {
  const items = useMemo<ClaudeItem[]>(() => {
    if (!claude) return [];
    const out: ClaudeItem[] = [];
    if (claude.project_md)
      out.push({
        id: "claude-md",
        title: "CLAUDE.md",
        subtitle: "Project instructions",
        badge: null,
        body: claude.project_md,
        section: "Instructions",
      });
    if (claude.global_md)
      out.push({
        id: "claude-md-global",
        title: "CLAUDE.md",
        subtitle: "Global (~/.claude)",
        badge: null,
        body: claude.global_md,
        section: "Instructions",
      });
    if (claude.index)
      out.push({
        id: "index",
        title: "Memory Index",
        subtitle: "MEMORY.md",
        badge: null,
        body: claude.index,
        section: "Index",
      });
    for (const e of claude.entries)
      out.push({
        id: e.name,
        title: e.title,
        subtitle: e.description,
        badge: e.kind || null,
        body: e.body,
        section: "Memories",
      });
    return out;
  }, [claude]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  // Cross-tab navigation (e.g. from Timeline): select + scroll to the doc.
  const navTarget = useMemoryStore.use.navTarget();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!navTarget || navTarget.sub !== "claude") return;
    const itemId = claudeItemIdForDoc(navTarget.id);
    if (itemId && items.some((i) => i.id === itemId)) {
      setSelectedId(itemId);
      requestAnimationFrame(() =>
        rowRefs.current.get(itemId)?.scrollIntoView({ block: "nearest" }),
      );
    }
  }, [navTarget, items]);

  const grouped = useMemo(() => {
    const order: ClaudeItem["section"][] = ["Instructions", "Index", "Memories"];
    return order
      .map((section) => ({ section, items: items.filter((i) => i.section === section) }))
      .filter((g) => g.items.length > 0);
  }, [items]);

  if (!claude || items.length === 0) {
    return (
      <Centered>
        <div className="text-center space-y-1.5 max-w-[300px] px-4">
          <ClaudeIcon className="size-6 mx-auto opacity-40" />
          <p className="text-[12px] text-[var(--text-secondary)]">No Claude memory yet</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            Claude Code writes per-project memory to{" "}
            <code className="text-[10px] break-all">
              {claude?.memory_dir ?? "~/.claude/projects/…/memory"}
            </code>{" "}
            as you work.
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="h-full flex">
      {/* List rail */}
      <aside className="w-[252px] shrink-0 border-r border-[var(--border-default)] overflow-y-auto hide-scrollbar bg-[var(--bg-sidebar)]">
        {grouped.map((g) => (
          <div key={g.section}>
            <div className="sticky top-0 z-10 px-3 py-1.5 bg-[var(--bg-sidebar)] text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
              {g.section}
            </div>
            {g.items.map((it) => {
              const active = selected?.id === it.id;
              return (
                <button
                  key={it.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(it.id, el);
                    else rowRefs.current.delete(it.id);
                  }}
                  onClick={() => setSelectedId(it.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 border-b border-[var(--border-subtle)] transition-colors cursor-pointer flex flex-col gap-0.5",
                    active
                      ? "bg-[var(--bg-selected)]"
                      : "hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {it.badge && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: KIND_TINT[it.badge] ?? "var(--text-tertiary)" }}
                      />
                    )}
                    <span
                      className={cn(
                        "text-[11px] truncate",
                        active
                          ? "text-[var(--text-primary)] font-medium"
                          : "text-[var(--text-secondary)]",
                      )}
                    >
                      {it.title}
                    </span>
                  </div>
                  {it.subtitle && (
                    <span className="text-[10px] text-[var(--text-tertiary)] line-clamp-2 leading-snug">
                      {it.subtitle}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Detail */}
      <main className="flex-1 min-w-0 overflow-y-auto hide-scrollbar">
        {selected && (
          <div className="px-6 py-5 max-w-[760px] mx-auto">
            <div className="flex items-center gap-2 mb-3">
              {selected.badge ? (
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    color: KIND_TINT[selected.badge] ?? "var(--text-tertiary)",
                    background: "var(--bg-elevated)",
                  }}
                >
                  {selected.badge}
                </span>
              ) : (
                <FileText size={12} className="text-[var(--text-tertiary)]" />
              )}
              <span className="text-[10px] text-[var(--text-tertiary)] font-mono">
                {selected.subtitle || selected.title}
              </span>
            </div>
            <Markdown className="text-[12.5px]">{selected.body}</Markdown>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Codex: full-bleed sessions data table (mirrors the BYOK keys panel) ──────

// Shared column tracks so the sticky header and every row line up. Session
// grows; the rest are fixed. A min-width track keeps columns from collapsing
// when the panel is narrow (the table scrolls horizontally instead).
const COL = {
  session: "flex-1 min-w-[280px]",
  model: "w-[150px] shrink-0",
  branch: "w-[130px] shrink-0",
  approval: "w-[120px] shrink-0",
  tokens: "w-[90px] shrink-0",
  updated: "w-[110px] shrink-0",
  chevron: "w-[32px] shrink-0",
} as const;
const TABLE_MIN_W = 280 + 150 + 130 + 120 + 90 + 110 + 32; // 912

function CodexView({ codex }: { codex: CodexMemory | null }) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAgents, setShowAgents] = useState(false);

  const hasAgents = !!(codex?.agents_md || codex?.global_agents_md);

  // Cross-tab navigation (e.g. from Timeline): expand + scroll to the thread,
  // or reveal AGENTS.md. Thread id may arrive raw or as "codex:<id>".
  const navTarget = useMemoryStore.use.navTarget();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!navTarget || navTarget.sub !== "codex") return;
    const rest = navTarget.id.startsWith("codex:")
      ? navTarget.id.slice("codex:".length)
      : navTarget.id;
    if (rest === "AGENTS.md") {
      setShowAgents(true);
      return;
    }
    setQuery(""); // clear any filter so the row is in the list
    setExpandedId(rest);
    requestAnimationFrame(() => rowRefs.current.get(rest)?.scrollIntoView({ block: "center" }));
  }, [navTarget]);

  const rows = useMemo(() => {
    const list = codex?.threads ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.first_user_message || "").toLowerCase().includes(q) ||
        (t.model || "").toLowerCase().includes(q) ||
        (t.git_branch || "").toLowerCase().includes(q),
    );
  }, [codex, query]);

  if (!codex) {
    return (
      <Centered>
        <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
      </Centered>
    );
  }

  if (codex.threads.length === 0 && !hasAgents) {
    return (
      <Centered>
        <div className="text-center space-y-1.5 max-w-[320px] px-4">
          <CodexIcon className="size-6 mx-auto opacity-40" />
          <p className="text-[12px] text-[var(--text-secondary)]">No Codex memory yet</p>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            Codex tracks per-project sessions in its state database and reads an{" "}
            <code className="text-[10px]">AGENTS.md</code> if present. Run Codex in this
            project to populate it.
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          Sessions
          <span className="ml-1.5 text-[9px] text-[var(--text-tertiary)] tabular-nums">
            {codex.threads.length}
          </span>
        </span>

        <div className="flex-1" />

        {hasAgents && (
          <button
            onClick={() => setShowAgents((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 h-6 rounded-md border px-2 text-[11px] transition-colors cursor-pointer",
              showAgents
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
            title="Toggle AGENTS.md"
          >
            <BookText size={11} />
            AGENTS.md
          </button>
        )}

        <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 w-[200px] focus-within:border-[var(--border-strong)]">
          <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
        </div>
      </div>

      {/* AGENTS.md drawer */}
      {showAgents && hasAgents && (
        <div className="shrink-0 max-h-[40%] overflow-y-auto hide-scrollbar border-b border-[var(--border-default)] bg-[var(--bg-sidebar)] px-4 py-3 space-y-2">
          {codex.agents_md && (
            <AgentsCard label="AGENTS.md · project" body={codex.agents_md} />
          )}
          {codex.global_agents_md && (
            <AgentsCard label="AGENTS.md · global" body={codex.global_agents_md} />
          )}
        </div>
      )}

      {/* Table — both-axis scroll, min-width track, sticky header. */}
      <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border-default)] bg-[var(--bg-base)] px-3 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            <span className={COL.session}>Session</span>
            <span className={COL.model}>Model</span>
            <span className={COL.branch}>Branch</span>
            <span className={COL.approval}>Approval</span>
            <span className={cn(COL.tokens, "text-right")}>Tokens</span>
            <span className={cn(COL.updated, "text-right")}>Updated</span>
            <span className={COL.chevron} />
          </div>

          {rows.length === 0 ? (
            <div className="grid place-items-center h-[160px] text-[11px] text-[var(--text-tertiary)]">
              No sessions match.
            </div>
          ) : (
            rows.map((t) => {
              const k = t.id || `${t.created_at}`;
              return (
                <CodexRow
                  key={t.id || `${t.created_at}-${t.updated_at}`}
                  thread={t}
                  expanded={expandedId === k}
                  innerRef={(el) => {
                    if (el) rowRefs.current.set(k, el);
                    else rowRefs.current.delete(k);
                  }}
                  onToggle={() => setExpandedId((cur) => (cur === k ? null : k))}
                />
              );
            })
          )}
        </div>
      </div>

      {codex.db_path && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 h-[22px] flex items-center text-[9px] text-[var(--text-ghost)] font-mono truncate">
          {codex.db_path}
        </div>
      )}
    </div>
  );
}

function CodexRow({
  thread: t,
  expanded,
  onToggle,
  innerRef,
}: {
  thread: CodexThread;
  expanded: boolean;
  onToggle: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={innerRef} className="border-b border-[var(--border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors",
          expanded ? "bg-[var(--bg-elevated)]/50" : "hover:bg-[var(--bg-hover)]",
        )}
      >
        <span className={cn(COL.session, "min-w-0 pr-3")}>
          <span className="block truncate text-[12px] text-[var(--text-primary)]">
            {cleanTitle(t.title || t.first_user_message) || "Untitled session"}
          </span>
        </span>
        <span className={cn(COL.model, "truncate font-mono text-[10px] text-[var(--text-tertiary)]")}>
          {t.model || "—"}
        </span>
        <span className={cn(COL.branch, "truncate")}>
          {t.git_branch ? (
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              {t.git_branch}
            </span>
          ) : (
            <span className="text-[var(--text-ghost)]">—</span>
          )}
        </span>
        <span className={COL.approval}>
          {t.approval_mode ? (
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-tertiary)] text-[10px]">
              {t.approval_mode}
            </span>
          ) : (
            <span className="text-[var(--text-ghost)] text-[11px]">—</span>
          )}
        </span>
        <span className={cn(COL.tokens, "text-right tabular-nums text-[11px] text-[var(--text-tertiary)]")}>
          {t.tokens_used ? formatTokens(t.tokens_used) : "—"}
        </span>
        <span className={cn(COL.updated, "text-right text-[10px] text-[var(--text-tertiary)]")}>
          {t.updated_at
            ? timeAgo(new Date(t.updated_at * 1000).toISOString(), { suffix: true })
            : "—"}
        </span>
        <span className={cn(COL.chevron, "flex items-center justify-end text-[var(--text-tertiary)]")}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && <CodexDetail thread={t} />}
    </div>
  );
}

function CodexDetail({ thread: t }: { thread: CodexThread }) {
  const message = (t.first_user_message || t.title || "").trim();
  return (
    <div className="bg-[var(--bg-elevated)]/40 border-t border-[var(--border-subtle)] px-4 py-4">
      {/* Metadata chips */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
        <MetaChip icon={Cpu} label="Model" value={t.model || "—"} mono />
        <MetaChip icon={GitBranch} label="Branch" value={t.git_branch || "—"} mono />
        <MetaChip icon={ShieldCheck} label="Approval" value={t.approval_mode || "—"} />
        <MetaChip
          icon={Coins}
          label="Tokens"
          value={t.tokens_used ? t.tokens_used.toLocaleString() : "—"}
        />
        <MetaChip icon={Clock} label="Started" value={fmtDateTime(t.created_at)} />
        <MetaChip icon={Clock} label="Updated" value={fmtDateTime(t.updated_at)} />
      </div>

      {/* Full first-message content */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 h-[26px] border-b border-[var(--border-subtle)] bg-[var(--bg-elevated-2)]">
          <FileText size={11} className="text-[var(--text-tertiary)]" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            First message
          </span>
        </div>
        <div className="px-4 py-3 max-h-[420px] overflow-y-auto hide-scrollbar">
          {message ? (
            <Markdown className="text-[12px]">{message}</Markdown>
          ) : (
            <p className="text-[11px] text-[var(--text-tertiary)]">No message recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaChip({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={11} className="text-[var(--text-ghost)]" />
      <span className="text-[10px] text-[var(--text-tertiary)]">{label}</span>
      <span
        className={cn(
          "text-[11px] text-[var(--text-secondary)]",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function AgentsCard({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 h-[28px] border-b border-[var(--border-subtle)] bg-[var(--bg-elevated-2)]">
        <BookText size={11} className="text-[var(--text-tertiary)]" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
      <div className="px-4 py-3">
        <Markdown className="text-[12px]">{body}</Markdown>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Map a memory-doc id ("claude:…") to a ClaudeView list-item id. */
function claudeItemIdForDoc(docId: string): string | null {
  if (!docId.startsWith("claude:")) return null;
  const rest = docId.slice("claude:".length);
  if (rest === "MEMORY.md") return "index";
  if (rest === "CLAUDE.md") return "claude-md";
  if (rest === "CLAUDE.md@global") return "claude-md-global";
  return rest; // a memory entry — its id is the file name
}

/** Strip the appended Atlas-context block + collapse whitespace for table rows. */
function cleanTitle(s: string): string {
  const cut = s.split("\n---\n")[0] ?? s;
  return cut.replace(/\s+/g, " ").trim();
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function fmtDateTime(sec: number): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
