import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Search,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { BoardSession } from "../types";

/**
 * Every Session captured across the Organisation's projects.
 *
 * Grouped by day rather than listed flat, because the question a developer
 * actually asks is "what did I do on Tuesday" — a scroll of 200 undifferentiated
 * rows answers it far worse than five dated groups do.
 *
 * The row carries only what identifies a Session: what was asked, which agent
 * answered, and how much landed in git. Everything else is one click away, and
 * putting it here would make every row look like every other row.
 */

interface Props {
  sessions: BoardSession[];
  /** True while the first read for this Workspace is in flight. */
  loading: boolean;
  /** The project is passed back because each one has its own store. */
  onOpen: (id: string, projectPath: string) => void;
}

export function SessionList({ sessions, loading, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleCluster = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const branches = useMemo(() => {
    const all = new Set<string>();
    for (const session of sessions)
      for (const b of session.branches) all.add(b);
    return [...all].sort();
  }, [sessions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (branch && !session.branches.includes(branch)) return false;
      if (!needle) return true;
      // Title, agent and model — the three things someone would type. Message
      // bodies are deliberately not searched: full-text over every Session is a
      // different feature with a different index behind it, and pretending to
      // offer it here would just return nothing for the queries it invites.
      return [session.title, session.agent, session.model]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(needle));
    });
  }, [sessions, query, branch]);

  const groups = useMemo(() => groupByDay(visible), [visible]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
        <div className="relative flex-1 max-w-[420px]">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions..."
            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] py-1.5 pl-7 pr-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-focus)]"
          />
        </div>

        {/* Only offered once there is more than one branch to choose between —
         *  a select with a single option is furniture, not a control. */}
        {branches.length > 1 && (
          <label className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1.5">
            <GitBranch size={12} className="text-[var(--text-tertiary)]" />
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="bg-transparent text-[12px] text-[var(--text-secondary)] outline-none"
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="py-8 text-center text-[12px] text-[var(--text-tertiary)]">
            Reading the session store…
          </p>
        ) : groups.length === 0 ? (
          <Empty filtered={sessions.length > 0} />
        ) : (
          groups.map(([day, rows]) => (
            <section key={day}>
              <header className="sticky top-0 z-10 flex items-baseline justify-between bg-[var(--bg-surface)] py-2">
                <h2 className="text-[12px] font-medium text-[var(--text-primary)]">
                  {day}
                </h2>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {rows.length} session{rows.length === 1 ? "" : "s"}
                </span>
              </header>
              <ul>
                {clusterRows(rows).map((item) =>
                  item.kind === "single" ? (
                    <SessionRow
                      key={item.session.id}
                      session={item.session}
                      onOpen={onOpen}
                    />
                  ) : (
                    <ClusterRow
                      key={`${day}:${item.title}`}
                      item={item}
                      expanded={expanded.has(`${day}:${item.title}`)}
                      onToggle={() => toggleCluster(`${day}:${item.title}`)}
                      onOpen={onOpen}
                    />
                  ),
                )}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** A day's rows, with runs of identical automated imports folded together. */
type ListItem =
  | { kind: "single"; session: BoardSession }
  | { kind: "cluster"; title: string; sessions: BoardSession[] };

/**
 * Fold imported sessions that share an identical title into one row.
 *
 * Hook-driven automation — a security-review run per edit batch, a scheduled
 * job — produces dozens of transcripts a day with the same first prompt, and a
 * list where forty rows say the same thing drowns the four the developer
 * actually ran. Three is the threshold: two identical titles is coincidence, a
 * run of them is a machine. Only imported sessions fold — live captures are
 * something the developer did here, however repetitive.
 */
function clusterRows(rows: BoardSession[]): ListItem[] {
  const byTitle = new Map<string, number>();
  for (const session of rows) {
    if (session.source === "external_jsonl" && session.title) {
      byTitle.set(session.title, (byTitle.get(session.title) ?? 0) + 1);
    }
  }

  const items: ListItem[] = [];
  const folded = new Map<string, BoardSession[]>();
  for (const session of rows) {
    const foldable =
      session.source === "external_jsonl" &&
      session.title !== null &&
      (byTitle.get(session.title) ?? 0) >= 3;
    if (!foldable) {
      items.push({ kind: "single", session });
      continue;
    }
    const bucket = folded.get(session.title!);
    if (bucket) {
      bucket.push(session);
    } else {
      const sessions: BoardSession[] = [session];
      folded.set(session.title!, sessions);
      // Placed where its first member sat, so folding never reorders the day.
      items.push({ kind: "cluster", title: session.title!, sessions });
    }
  }
  return items;
}

function ClusterRow({
  item,
  expanded,
  onToggle,
  onOpen,
}: {
  item: Extract<ListItem, { kind: "cluster" }>;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string, projectPath: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]"
      >
        {expanded ? (
          <ChevronDown
            size={12}
            className="shrink-0 text-[var(--text-tertiary)]"
          />
        ) : (
          <ChevronRight
            size={12}
            className="shrink-0 text-[var(--text-tertiary)]"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-secondary)]">
          {item.title}
        </span>
        <span className="shrink-0 rounded bg-[var(--bg-selected)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text-tertiary)]">
          ×{item.sessions.length}
        </span>
        <span className="hidden shrink-0 text-[10px] text-[var(--text-muted)] sm:block">
          automated runs
        </span>
      </button>
      {expanded && (
        <ul className="ml-5 border-l border-[var(--border-subtle)] pl-1">
          {item.sessions.map((session) => (
            <SessionRow key={session.id} session={session} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: BoardSession;
  onOpen: (id: string, projectPath: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(session.id, session.projectPath)}
        className="group flex w-full items-center gap-3 rounded px-2 py-2 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
          {session.title ?? (
            <span className="text-[var(--text-tertiary)]">
              Untitled session
            </span>
          )}
        </span>

        {/* The board spans every project, so a row that does not name its own
         *  is unreadable the moment two projects are captured. Shown even when
         *  filtered to one — the filter is a header control, not a row label. */}
        <span className="hidden shrink-0 rounded bg-[var(--bg-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-tertiary)] md:block">
          {session.projectName}
        </span>

        {/* A Session that could not be fully recorded says so where it is read.
         *  Finding a hole while reading the history is far too late. */}
        {session.needsAttention && (
          <TriangleAlert
            size={12}
            className="shrink-0 text-[var(--status-warning)]"
            aria-label={session.attentionReason ?? "Partially recorded"}
          />
        )}

        {/* Back-filled from an on-disk transcript, not captured live. Without
         *  the chip these read as live captures whose commit linking failed —
         *  the feature looking broken is exactly what the marker prevents. */}
        {session.source === "external_jsonl" && (
          <span className="hidden shrink-0 rounded border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] sm:block">
            imported
          </span>
        )}

        {session.agent && <AgentBadge agent={session.agent} />}

        <span className="hidden w-[92px] shrink-0 truncate text-right font-mono text-[11px] text-[var(--text-tertiary)] sm:block">
          {prettyModel(session.model) ?? ""}
        </span>

        {/* Zero renders as silence, not as "no checkpoints" filler — a list
         *  where most rows print their own absence reads as one long shrug.
         *  The fixed width stays so the columns hold their alignment. */}
        <span className="w-[104px] shrink-0 text-right text-[11px] tabular-nums text-[var(--text-tertiary)]">
          {session.checkpointCount > 0 &&
            `${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? "" : "s"}`}
        </span>
      </button>
    </li>
  );
}

/**
 * Which agent produced the Session.
 *
 * Colour-coded per agent so a mixed list is scannable without reading, using
 * the per-agent chip tokens the design system already carries — the status
 * ramp is for status, and painting Claude with the warning colour made every
 * row read as a problem. An unrecognised agent gets the neutral tone, not
 * Claude's.
 */
/**
 * Turn a raw model id into the name a person says.
 *
 * The wire carries ids like `claude-fable-5[1m]` or `gpt-5.5-codex`; the
 * reference surfaces show "Fable 5" and "GPT-5.5". Derived, best-effort, and
 * falling back to the raw id — a name we cannot prettify is still a name.
 */
export function prettyModel(model: string | null): string | null {
  if (!model) return null;
  const raw = model.replace(/\[.*?\]/g, "").trim();
  const m = raw.toLowerCase();
  const versioned = (family: string) => {
    const version = raw.match(/(\d+(?:\.\d+)?)/)?.[1];
    return version ? `${family} ${version}` : family;
  };
  if (m.includes("fable")) return versioned("Fable");
  if (m.includes("opus")) return versioned("Opus");
  if (m.includes("sonnet")) return versioned("Sonnet");
  if (m.includes("haiku")) return versioned("Haiku");
  if (m.startsWith("gpt")) return raw.toUpperCase().replace("-CODEX", " Codex");
  return raw;
}

export function AgentBadge({
  agent,
  className,
}: {
  agent: string;
  className?: string;
}) {
  const tone = agent.includes("claude")
    ? "text-[var(--agent-claude-chip)] bg-[var(--agent-claude-chip-bg)]"
    : agent.includes("codex")
      ? "text-[var(--agent-codex-chip)] bg-[var(--agent-codex-chip-bg)]"
      : agent.includes("cersei")
        ? "text-[var(--agent-local-chip)] bg-[var(--agent-local-chip-bg)]"
        : "text-[var(--text-secondary)] bg-[var(--bg-selected)]";

  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]",
        className ?? "hidden md:block",
        tone,
      )}
    >
      {label(agent)}
    </span>
  );
}

function label(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  if (agent.includes("cersei")) return "Atlas";
  return agent;
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="py-12 text-center">
      <p className="text-[12px] text-[var(--text-secondary)]">
        {filtered
          ? "No sessions match this filter."
          : "No sessions captured yet."}
      </p>
      {!filtered && (
        <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
          Send a prompt to an agent in this Workspace and it will appear here.
        </p>
      )}
    </div>
  );
}

/**
 * Group into `Today` / `Yesterday` / weekday-and-date buckets.
 *
 * The input is already newest-first from the store, so insertion order into the
 * Map preserves the grouping order and no second sort is needed.
 */
function groupByDay(sessions: BoardSession[]): Array<[string, BoardSession[]]> {
  const groups = new Map<string, BoardSession[]>();
  for (const session of sessions) {
    const day = dayLabel(new Date(session.updatedAt));
    const bucket = groups.get(day);
    if (bucket) bucket.push(session);
    else groups.set(day, [session]);
  }
  return [...groups.entries()];
}

function dayLabel(date: Date): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    // The year only earns its space once it is ambiguous.
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
