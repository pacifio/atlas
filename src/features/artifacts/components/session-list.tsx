/**
 * The board: every recorded Session, newest first, on a continuous rail.
 *
 * The rail is the point. A day's sessions are one thread with a node per
 * session, so the eye follows a sequence rather than scanning a table — the
 * feature is called a Timeline and this is the only part of it that looks like
 * one. The columns to the right of the title are fixed-width on purpose: agent,
 * model and duration line up down the whole day, which is what makes an outlier
 * visible without reading a single row.
 *
 * Runs of identically-titled *imported* sessions fold into one row. Hook-driven
 * automation produces dozens of transcripts a day with the same first prompt,
 * and a list where forty rows say the same thing drowns the four a person
 * actually ran.
 */

import { useMemo, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  TriangleAlert,
} from "lucide-react";

import { AgentIcons } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";

import { cn } from "@/lib/utils";

import {
  agentLabel,
  formatDuration,
  groupByDay,
  prettyModel,
  sessionState,
  sessionTitle,
  tokenLabel,
  type SessionState,
} from "../lib/board";
import type { BoardSession } from "../types";

interface Props {
  sessions: BoardSession[];
  /** True while the first read for this Workspace is in flight. */
  loading: boolean;
  /** True when a search or facet is narrowing the board — changes the empty copy. */
  filtered: boolean;
  /** The project is passed back because each one has its own store. */
  onOpen: (id: string, projectPath: string) => void;
}

/** Fold a run of identical imported titles at this length or above. */
const FOLD_AT = 3;

export function SessionList({ sessions, loading, filtered, onOpen }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const days = useMemo(() => groupByDay(sessions), [sessions]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (loading) {
    return (
      <p className="py-8 text-center text-[12px] text-[var(--text-tertiary)]">
        Reading the session store…
      </p>
    );
  }
  if (days.length === 0) return <Empty filtered={filtered} />;

  return (
    <div>
      {days.map((day) => {
        const items = clusterRows(day.sessions);
        return (
          <section key={day.label}>
            {/* Sticks under the 32px header, so the day you are reading is
                always named even halfway down a long month. */}
            <header className="sticky top-0 z-20 flex h-[30px] items-center justify-between border-b border-[var(--border-default)] border-t border-[var(--border-subtle)] bg-[var(--bg-raised)] px-5">
              <span className="flex items-baseline gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  {day.label}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                  {day.date}
                </span>
              </span>
              <span className="font-mono text-[10px] text-[var(--text-tertiary)]">{day.meta}</span>
            </header>

            {items.map((item, i) =>
              item.kind === "single" ? (
                <SessionRow
                  key={item.session.id}
                  session={item.session}
                  first={i === 0}
                  last={i === items.length - 1}
                  onOpen={onOpen}
                />
              ) : (
                <ClusterRow
                  key={`${day.label}:${item.title}`}
                  item={item}
                  first={i === 0}
                  last={i === items.length - 1}
                  expanded={expanded.has(`${day.label}:${item.title}`)}
                  onToggle={() => toggle(`${day.label}:${item.title}`)}
                  onOpen={onOpen}
                />
              ),
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The grid every row shares.
 *
 * `22px` rail · flexible title · agent · model · duration. Held in one constant
 * because a cluster's child rows have to line up with its siblings exactly —
 * two grids that drift by a pixel turn the rail into a zigzag.
 */
const ROW_GRID = "grid grid-cols-[22px_minmax(0,1fr)_28px_92px_68px] items-center gap-4 px-5";

/** Row height. Two lines of content, so taller than the single-line first pass. */
const ROW_H = "h-14";

function SessionRow({
  session,
  first,
  last,
  onOpen,
}: {
  session: BoardSession;
  first: boolean;
  last: boolean;
  onOpen: (id: string, projectPath: string) => void;
}) {
  const state = sessionState(session);
  const branch = session.branches[0];
  // Everything after the branch, each already a complete phrase. Empty entries
  // are dropped rather than rendered as a bare separator.
  const meta = [
    session.projectName,
    tokenLabel(session),
    session.checkpointCount > 0
      ? `${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <button
      type="button"
      onClick={() => onOpen(session.id, session.projectPath)}
      title={session.attentionReason ?? undefined}
      className={cn(
        ROW_GRID,
        ROW_H,
        "w-full cursor-pointer text-left transition-colors hover:bg-[var(--bg-hover)]",
        !last && "border-b border-dashed border-[var(--border-default)]",
        state === "attention" && "bg-[var(--status-warning-muted)]/40",
      )}
    >
      <Rail first={first} last={last}>
        <Node state={state} />
      </Rail>

      <span className="flex min-w-0 flex-col gap-1">
        {/* Two lines, as in the reference: the title is the thing you read, and
            the branch / tokens are what you check once you have found it.
            Side by side they competed for the same horizontal space and the
            title truncated first — which is exactly backwards. */}
        <span
          className={cn(
            "min-w-0 truncate text-[13px] leading-tight tracking-[-0.01em]",
            state === "done" ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
          )}
        >
          {sessionTitle(session.title) ?? (
            <span className="text-[var(--text-tertiary)]">Untitled session</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-tight text-[var(--text-tertiary)]">
          {branch && (
            <>
              <GitBranch size={9} className="shrink-0" />
              <span className="truncate">{branch}</span>
            </>
          )}
          {meta.map((part) => (
            <span key={part} className="shrink-0 whitespace-nowrap">
              <span className="mr-1.5 text-[var(--text-ghost)]">·</span>
              {part}
            </span>
          ))}
        </span>
      </span>

      <AgentChip agent={session.agent} />

      <span className="justify-self-end truncate font-mono text-[11px] text-[var(--text-tertiary)]">
        {prettyModel(session.model) ?? ""}
      </span>

      {/* A recording session's duration is still climbing, so it is marked —
          green with a leading dot, matching the node on the rail. */}
      <span
        className={cn(
          "justify-self-end whitespace-nowrap font-mono text-[11px]",
          state === "live" ? "text-[var(--capture-live)]" : "text-[var(--text-secondary)]",
        )}
      >
        {state === "live" && <span className="mr-1">·</span>}
        {formatDuration(session.durationSeconds)}
      </span>
    </button>
  );
}

/**
 * The vertical thread through a day.
 *
 * Half-height at the ends so the line starts and stops at the first and last
 * node rather than running off into the day header.
 *
 * **An expanded cluster does not connect to its children.** Four attempts at
 * drawing that join — a curve, a chamfer, an offset elbow, one continuous path
 * — each looked wrong in a different way, and none of them earned the pixel
 * budget: the indent already says the children belong to the row above, and a
 * connector adds nothing the eye was missing. The cluster's rail simply stops at
 * its own node, and the children start a fresh thread of their own.
 */
function Rail({
  first,
  last,
  children,
}: {
  first: boolean;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="relative flex h-full items-center justify-center">
      <span
        aria-hidden
        className="absolute left-1/2 -ml-px w-px bg-[var(--border-strong)]"
        style={{
          // −1px, not 0, at the joins. Each row carries its dashed divider as a
          // `border-b`, and a grid area is the CONTENT box — so `bottom: 0`
          // stops the rail *above* that border and leaves a 1px hole at every
          // single row boundary. Bleeding one pixel past the box bridges it.
          top: first ? "50%" : -1,
          bottom: last ? "50%" : -1,
        }}
      />
      {children}
    </span>
  );
}

/**
 * What state the session is in, as one glyph on the rail.
 *
 * Four marks, each doing one job — a green ring around a small filled dot while
 * an agent is still writing, a tick once it has settled, an arrow for something
 * read off disk, a triangle when the record has a hole in it.
 *
 * **Thin strokes, generous inset.** A 20px ring holding a 9px hairline glyph is
 * the whole look: the first pass used a 2.2 stroke on a 10px glyph inside an
 * 18px ring, which filled the circle edge to edge and turned a delicate rail
 * into a column of heavy buttons. The ring is the shape you see; the glyph is a
 * detail you read on the second pass.
 */
function Node({ state }: { state: SessionState }) {
  if (state === "live") {
    return (
      <span
        className="atlas-live-pulse relative z-10 flex size-5 items-center justify-center rounded-full border bg-[var(--bg-surface)]"
        style={{
          borderColor: "color-mix(in oklab, var(--capture-live) 55%, transparent)",
          ["--atlas-pulse-color" as string]:
            "color-mix(in oklab, var(--capture-live) 40%, transparent)",
        }}
        title="Recording now"
      >
        <span
          className="size-[6px] rounded-full"
          style={{ backgroundColor: "var(--capture-live)" }}
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "relative z-10 flex size-5 items-center justify-center rounded-full border bg-[var(--bg-surface)]",
        state === "attention"
          ? "border-[var(--status-warning)]/50 text-[var(--status-warning)]"
          : "border-[var(--border-strong)] text-[var(--text-tertiary)]",
      )}
      title={
        state === "attention"
          ? "Partially recorded"
          : state === "imported"
            ? "Imported from disk"
            : "Recorded"
      }
    >
      {state === "attention" ? (
        <TriangleAlert size={9} strokeWidth={1.5} />
      ) : state === "imported" ? (
        <ArrowDown size={9} strokeWidth={1.5} />
      ) : (
        <Check size={9} strokeWidth={1.5} />
      )}
    </span>
  );
}

/**
 * Which agent produced the Session — its mark in a bare pill.
 *
 * Same shape as the chat composer's agent pill: `rounded-full`, a hairline
 * border, no fill. The tinted background it had before made every row carry a
 * coloured block that competed with the title for attention — and on a board
 * where nearly every row is the same agent, that is a block of colour saying
 * nothing. The brand icon keeps its own colour; the container gets out of its
 * way. The full name survives as the tooltip.
 */
function AgentChip({ agent }: { agent: string | null }) {
  if (!agent) return <span />;
  return (
    <span
      title={agentLabel(agent)}
      aria-label={agentLabel(agent)}
      className="flex size-5 items-center justify-center justify-self-start rounded-full border border-[var(--border-default)]"
    >
      <AgentGlyph agent={agent} />
    </span>
  );
}

/**
 * The agent's mark.
 *
 * Shared with the Session detail, whose timeline nodes and header chip need the
 * same three glyphs. The letter fallback matters: a plugin id we have no mark
 * for still has to render as *something* identifying.
 *
 * `mono` drops the brand tint and inherits the surrounding colour, which is how
 * the chat composer badges its agent — the board's rows keep the tint, because
 * there the colour is what tells two adjacent rows apart at a glance.
 *
 * `size` is in pixels, because the two callers want genuinely different marks:
 * an 11px chip glyph in a fixed column, and a 16px avatar on the detail's
 * timeline rail where the mark is what identifies the turn.
 */
export function AgentGlyph({
  agent,
  mono,
  size = 11,
}: {
  agent: string;
  mono?: boolean;
  size?: number;
}) {
  const dim = { width: size, height: size };
  if (agent.includes("claude"))
    return (
      <AgentIcons.Claude style={dim} className={cn(!mono && "text-[var(--agent-claude-chip)]")} />
    );
  if (agent.includes("codex"))
    return (
      <AgentIcons.Codex style={dim} className={cn(!mono && "text-[var(--agent-codex-chip)]")} />
    );
  if (agent.includes("opencode"))
    return (
      <AgentIcons.OpenCode
        style={dim}
        className={cn(!mono && "text-[var(--agent-opencode-chip)]")}
      />
    );
  if (agent.includes("cersei")) return <AtlasIcon size={size} className="rounded-[3px]" />;
  return (
    <span className="font-mono" style={{ fontSize: size * 0.8 }}>
      {agent.slice(0, 1).toUpperCase()}
    </span>
  );
}

// ── Clustering ──────────────────────────────────────────────────────────────

type ListItem =
  | { kind: "single"; session: BoardSession }
  | { kind: "cluster"; title: string; sessions: BoardSession[] };

/**
 * Fold imported sessions that share an identical title into one row.
 *
 * Three is the threshold: two identical titles is coincidence, a run of them is
 * a machine. Only imported sessions fold — live captures are something the
 * developer did here, however repetitive.
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
      (byTitle.get(session.title) ?? 0) >= FOLD_AT;
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
  first,
  last,
  expanded,
  onToggle,
  onOpen,
}: {
  item: Extract<ListItem, { kind: "cluster" }>;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string, projectPath: string) => void;
}) {
  const minutes = item.sessions.reduce((a, s) => a + s.durationSeconds, 0);
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          ROW_GRID,
          ROW_H,
          "w-full cursor-pointer text-left transition-colors hover:bg-[var(--bg-hover)]",
          !last && !expanded && "border-b border-dashed border-[var(--border-default)]",
          // Expanded, this row is a container rather than a session, and it
          // takes `--bg-elevated-2` — the ramp's next step ABOVE the day
          // header's `--bg-raised`. It sat on `--bg-raised` too for a moment,
          // which merged the two into one block: an open cluster is nested
          // inside a day, so it has to read as nearer the viewer, not level
          // with the thing containing it. Three steps now — #000 base, #0f0f0f
          // day header, #161616 open cluster.
          //
          // A token rather than a hex so the themes carry it: One Dark and the
          // rest remap this ramp, and a literal would stay black in all of them.
          //
          // The bottom border is `--border-strong` — the same colour and width
          // as the rail, not the dividers' darker `--border-default`. It is the
          // horizontal continuation of the same stroke, so a heavier weight
          // there reads as a seam rather than as one intact line.
          expanded && "border-b border-[var(--border-strong)] bg-[var(--bg-elevated-2)]",
        )}
      >
        {/* `last` once expanded: the thread ends at this node. The children
            begin their own below — there is no connector, and the indent is
            what says they belong to this row. */}
        <Rail first={first} last={last || expanded}>
          {/* The node's fill has to follow the row's, or an expanded cluster
              shows an unlifted disc punched through its own background. */}
          <span
            className={cn(
              "relative z-10 flex size-5 items-center justify-center rounded-full border border-[var(--border-strong)] text-[var(--text-tertiary)]",
              expanded ? "bg-[var(--bg-elevated-2)]" : "bg-[var(--bg-surface)]",
            )}
          >
            {expanded ? (
              <ChevronDown size={9} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={9} strokeWidth={1.5} />
            )}
          </span>
        </Rail>

        <span className="flex min-w-0 flex-col gap-1">
          <span className="min-w-0 truncate text-[13px] leading-tight tracking-[-0.01em] text-[var(--text-secondary)]">
            {item.title}
          </span>
          <span className="font-mono text-[11px] leading-tight text-[var(--text-tertiary)]">
            ×{item.sessions.length} automated runs
          </span>
        </span>

        <span />
        <span />
        <span className="justify-self-end whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]">
          {formatDuration(minutes)}
        </span>
      </button>

      {expanded && (
        // Indented so the children read as belonging to the row above. That
        // indent is the whole relationship — no connector needed.
        <div className="border-b border-dashed border-[var(--border-default)] bg-[var(--bg-base)] pl-4">
          {item.sessions.map((session, i) => (
            <SessionRow
              key={session.id}
              session={session}
              // `first={false}` even for the first child, deliberately: `first`
              // only decides whether the rail starts half-way down, and here it
              // must run to the TOP of the block instead. The children are a
              // group that begins at the container's edge — a thread starting
              // mid-air at the first node reads as if something above it was
              // cut off.
              first={false}
              last={i === item.sessions.length - 1}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="py-12 text-center">
      <p className="text-[12px] text-[var(--text-secondary)]">
        {filtered ? "No sessions match this filter." : "No sessions captured yet."}
      </p>
      {!filtered && (
        <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
          Send a prompt to an agent in this Workspace and it will appear here.
        </p>
      )}
    </div>
  );
}
