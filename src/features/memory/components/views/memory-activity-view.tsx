// The Activity tab, props-only: how memory changed, newest first, down the
// history rail. One row per session that wrote something, under day
// headings; each line says what the agent did ("decided", "learned", "hit a
// dead end") and, when it became a memory that still stands, opens it.
// This replaces the raw event and plan tables: the same log, read the way a
// person asks about it ("what did Codex take away from yesterday?").
//
// Only the rows on screen at first paint fade in, once, as the session
// timeline's rows do (`session-row-in`, a CSS animation the package turns off
// under reduced motion).

import { useState } from "react";
import { Brain, ChevronDown, ExternalLink, History, Search, X } from "lucide-react";
import { AgentGlyph } from "@/components/brand-marks";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button, EmptyState, Skeleton } from "@tryatlas/design";
import { KIND_ICON } from "../../lib/memory-kind-icon";
import {
  activityTally,
  type ActivityDay,
  type ActivityGroup,
  type ActivityLine,
} from "../../lib/memory-activity";
import { pluginIdForSource } from "../../lib/memory-agent";
import { AgentName } from "./memory-entry-parts";
import { RailNode, RailRow } from "./memory-rail";
import { FilterMenu } from "./shared-memory-primitives";
import { Notice } from "./memory-chrome";
import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
import {
  ASK_ROW,
  AskAgentButton,
  FixWithAgentButton,
} from "@/features/ask-agent/components/ask-agent-button";

/** A line's "Why did you learn this?": what it hands the agent, and where. */
export type WhyAsk = (
  line: ActivityLine,
  group: ActivityGroup,
) => { context: AgentContext[]; prompt: string; target: string };

/** A session with more lines than this folds the rest behind a count. */
const FOLD_OVER = 5;
/** Groups that fade in on first paint. */
const ENTRANCE_GROUPS = 12;

export interface MemoryActivityViewProps {
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  /** Whether the log has anything at all, before filters. */
  hasEvents: boolean;
  days: ActivityDay[];
  query: string;
  onQueryChange: (q: string) => void;
  agentFilter: string;
  agentOptions: string[];
  formatAgent: (agent: string) => string;
  onAgentFilterChange: (agent: string) => void;
  onOpenEntry: (id: number) => void;
  onOpenSession: (group: ActivityGroup) => void;
  whyAsk: WhyAsk;
}

export function MemoryActivityView(p: MemoryActivityViewProps) {
  // Decided once, at mount: the groups that were on screen then.
  const [entering] = useState(
    () =>
      new Set(
        p.days
          .flatMap((d) => d.groups)
          .slice(0, ENTRANCE_GROUPS)
          .map((g) => g.key),
      ),
  );
  const filtered = p.query.trim() !== "" || p.agentFilter !== "";
  let order = 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <label className="flex h-control-md min-w-40 flex-1 cursor-text items-center gap-1.5 rounded border border-border bg-panel-input px-2 focus-within:border-border-strong">
          <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={p.query}
            onChange={(e) => p.onQueryChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && p.query) {
                e.preventDefault();
                p.onQueryChange("");
              }
            }}
            placeholder="Search what changed…"
            aria-label="Search activity"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {p.query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => p.onQueryChange("")}
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          ) : null}
        </label>
        {p.agentOptions.length > 1 && (
          <FilterMenu
            label="Agent"
            value={p.agentFilter}
            options={p.agentOptions}
            onChange={p.onAgentFilterChange}
            format={p.formatAgent}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!p.loaded ? (
          <ActivityGhost />
        ) : p.error ? (
          <Notice
            title="Couldn't read this project's memory"
            action={
              <>
                <Button size="sm" variant="outline" onClick={p.onRetry}>
                  Try again
                </Button>
                <FixWithAgentButton
                  error={{ kind: "error", source: "Memory: reading the record", message: p.error }}
                />
              </>
            }
          >
            <span className="font-mono text-2xs break-words">{p.error}</span>
          </Notice>
        ) : p.days.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={filtered ? Search : History}
            title={filtered ? "Nothing matches" : "No memory activity yet"}
            description={
              filtered
                ? "Try fewer words, or another agent."
                : p.hasEvents
                  ? "Sessions here have started, but none has recorded a memory yet."
                  : "Each time an agent sets a plan, decides something or hits a dead end, it shows up here under its session."
            }
            action={
              filtered ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    p.onQueryChange("");
                    p.onAgentFilterChange("");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="mx-auto max-w-3xl px-4 pt-5 pb-16">
            {p.days.map((day) => (
              <section key={day.key} aria-label={day.label} className="mb-2">
                <h3 className="sticky top-0 z-panel mb-2 flex h-7 items-center bg-background text-2xs font-medium text-muted-foreground">
                  {day.label}
                </h3>
                {day.groups.map((group, i) => {
                  const enters = entering.has(group.key);
                  const delay = enters ? Math.min(order++, 8) * 30 : 0;
                  return (
                    <SessionGroup
                      key={group.key}
                      group={group}
                      first={i === 0}
                      last={i === day.groups.length - 1}
                      className={cn(enters && "session-row-in")}
                      style={enters ? { animationDelay: `${delay}ms` } : undefined}
                      onOpenEntry={p.onOpenEntry}
                      onOpenSession={() => p.onOpenSession(group)}
                      whyAsk={p.whyAsk}
                    />
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionGroup({
  group,
  first,
  last,
  className,
  style,
  onOpenEntry,
  onOpenSession,
  whyAsk,
}: {
  group: ActivityGroup;
  first: boolean;
  last: boolean;
  className?: string;
  style?: React.CSSProperties;
  onOpenEntry: (id: number) => void;
  onOpenSession: () => void;
  whyAsk: WhyAsk;
}) {
  const foldable = group.lines.length > FOLD_OVER;
  const [open, setOpen] = useState(!foldable);
  const shown = open ? group.lines : group.lines.slice(0, FOLD_OVER - 1);
  const folded = group.lines.slice(FOLD_OVER - 1);
  return (
    <RailRow
      first={first}
      last={last}
      className={className}
      style={style}
      node={
        <RailNode>
          <AgentGlyph agentType={pluginIdForSource(group.agent)} />
        </RailNode>
      }
    >
      <div className="group/session flex min-h-8 items-center gap-1.5 text-xs">
        <span className="min-w-0 truncate text-secondary-foreground">
          <AgentName agent={group.agent} strong />
        </span>
        <span className="shrink-0 text-muted-foreground">
          ·{" "}
          <time
            dateTime={new Date(group.end).toISOString()}
            title={new Date(group.end).toLocaleString()}
          >
            {timeAgo(new Date(group.end).toISOString(), { suffix: true })}
          </time>
        </span>
        <span className="ml-auto" />
        {group.sessionId ? (
          // A hint, not chrome: it stays out of the row until the row is
          // reached for, by pointer or by keyboard.
          <span className="opacity-0 transition-opacity duration-fast group-hover/session:opacity-100 focus-within:opacity-100">
            <Button size="xs" variant="ghost" onClick={onOpenSession}>
              <ExternalLink aria-hidden className="size-3" />
              Open the session
            </Button>
          </span>
        ) : null}
      </div>
      <ul className="mt-0.5 space-y-px">
        {shown.map((line) => (
          <Line key={line.seq} line={line} onOpenEntry={onOpenEntry} ask={whyAsk(line, group)} />
        ))}
      </ul>
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="mt-1 flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-foreground"
        >
          <ChevronDown aria-hidden className={cn("size-3", open && "rotate-180")} />
          {open ? "Show less" : `${folded.length} more: ${activityTally(folded)}`}
        </button>
      )}
    </RailRow>
  );
}

/** A line, short enough for a button's name. */
function whatLabel(line: ActivityLine): string {
  const flat = `${line.verb} ${line.path ?? line.text}`.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}

/** One thing the agent did. On hover it offers "Why did you learn this?",
 *  asked of the session that wrote it. */
function Line({
  line,
  onOpenEntry,
  ask,
}: {
  line: ActivityLine;
  onOpenEntry: (id: number) => void;
  ask: ReturnType<WhyAsk>;
}) {
  const Icon = KIND_ICON[line.kind] ?? Brain;
  const body = (
    <>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm leading-snug">
        <span className="text-muted-foreground">{line.verb} </span>
        {line.path ? (
          <code className="font-mono text-xs text-secondary-foreground">{line.path}</code>
        ) : null}
        {line.path && line.text ? <span className="text-muted-foreground"> — </span> : null}
        <span className="text-foreground">{line.text}</span>
      </span>
    </>
  );
  return (
    <li className={cn(ASK_ROW, "flex items-start gap-1")}>
      {line.entryId !== null ? (
        <button
          type="button"
          onClick={() => onOpenEntry(line.entryId!)}
          title="Open this memory"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-left transition-colors duration-fast ease-out-strong hover:bg-element-hover"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1">{body}</div>
      )}
      <AskAgentButton
        // Named for its line, so a list of them is not one name repeated.
        label={`Why did you learn this: ${whatLabel(line)}`}
        context={ask.context}
        prompt={ask.prompt}
        target={ask.target}
        className="mt-0.5 shrink-0"
      />
    </li>
  );
}

function ActivityGhost() {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Loading activity"
      className="mx-auto max-w-3xl space-y-6 px-4 pt-8"
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3.5">
          <Skeleton className="size-8 shrink-0" />
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
