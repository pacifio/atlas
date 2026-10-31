/**
 * One captured Session, as three short lines.
 *
 *   title                                    model
 *   branch · tokens · project
 *   author                      checkpoints · diff · comments
 *
 * Each line has a left and a right, so the eye reads two columns down the
 * board instead of hunting across a row of equal-weight cells. The state sits
 * on the rail beside it, outside the text, because it belongs to the Session
 * rather than to any one of its facts.
 *
 * The nav this replaced showed a title and a timestamp; everything else about
 * a run — which model, whose work, how much it cost, what it changed — meant
 * opening it. These are the facts you pick a Session *by*.
 */

import { GitBranch, MessageSquare } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { cn } from "@/lib/utils";
import type { BoardSession } from "../types";
import { formatTokens, sessionState, sessionTitle, tokenLabel } from "../lib/board";
import { authorOf, type AuthorDirectory } from "../lib/author-directory";
import { hueFor } from "../lib/hue";
import { AgentGlyph } from "./agent-glyph";
import { SessionStatusIcon, STATE_LABEL } from "./session-status-icon";
import { SessionSecurityBadge } from "@/features/security/components/session-security-badge";

export function SessionRow({
  session: s,
  directory,
  selected,
  onOpen,
}: {
  session: BoardSession;
  directory: AuthorDirectory;
  selected: boolean;
  onOpen: () => void;
}) {
  const state = sessionState(s);
  const who = authorOf(s.authorId, directory);
  const tokens = tokenLabel(s);
  const checkpoints =
    s.checkpointCount === 0
      ? "No checkpoints"
      : `${s.checkpointCount} ${s.checkpointCount === 1 ? "checkpoint" : "checkpoints"}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={cn(
        // Exactly as wide as the hairlines between rows, inside them with a
        // little air above and below (the row's wrapper in
        // `timeline-calendar.tsx`). It used to overhang the hairlines by 8px a
        // side, so a selected row's rounded corners stuck out past the rules
        // and butted against the one above it.
        "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left",
        "transition-colors duration-fast ease-out-strong hover:bg-element-hover",
        selected && "bg-element-selected hover:bg-element-selected",
      )}
    >
      <span
        title={STATE_LABEL[state]}
        className="flex h-5.5 w-5 shrink-0 items-center justify-center"
      >
        <SessionStatusIcon state={state} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <Line
          left={
            <span className="truncate text-sm font-medium text-foreground">
              {sessionTitle(s.title) ?? "Untitled session"}
            </span>
          }
          // The raw id, not a prettified name: on a board you are matching
          // this against what you set in the composer and what the bill says,
          // and both of those spell it `claude-opus-5-5`.
          right={s.model && <ModelBadge agent={s.agent} model={s.model} />}
        />

        <Line
          // Joined with separators rather than prefixed with them: a Session
          // with no branch and no tokens would otherwise open its line with a
          // dangling `·`.
          left={joinDots([
            s.branches[0] && (
              <span key="branch" className="flex min-w-0 items-center gap-1 font-mono">
                <GitBranch size={11} className="shrink-0" />
                <span className="truncate">{s.branches[0]}</span>
              </span>
            ),
            tokens && (
              <span key="tokens" className="shrink-0 font-mono">
                {tokens}
              </span>
            ),
            s.projectName && <ProjectMark key="project" name={s.projectName} />,
          ])}
        />

        <Line
          left={
            <span className="flex min-w-0 items-center gap-1.5 text-secondary-foreground">
              {who.avatar && <AccountAvatar user={who.avatar} size={16} />}
              <span className="truncate">{who.avatar?.name || who.label}</span>
            </span>
          }
          right={
            <span className="flex items-center gap-2">
              <SessionSecurityBadge projectPath={s.projectPath} sessionId={s.id} />
              <span className="shrink-0">{checkpoints}</span>
              {s.insertions + s.deletions > 0 && (
                <>
                  <Dot />
                  <DiffStat added={s.insertions} removed={s.deletions} />
                </>
              )}
            </span>
          }
        />
      </span>
    </button>
  );
}

/** One row line: content on the left, one item pinned right. */
function Line({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-3 text-2xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-2">{left}</span>
      {right && <span className="flex shrink-0 items-center">{right}</span>}
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-[var(--atlas-text-disabled)]">
      ·
    </span>
  );
}

/** The parts that are actually there, separated by dots. */
function joinDots(parts: (ReactNode | false | null | undefined)[]): ReactNode {
  const kept = parts.filter(Boolean) as ReactNode[];
  return kept.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <Dot />}
      {part}
    </Fragment>
  ));
}

/** The model this ran on, marked with the agent that drove it. */
export function ModelBadge({ agent, model }: { agent: string | null; model: string }) {
  return (
    <span className="inline-flex h-5.5 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 text-secondary-foreground">
      {agent && <AgentGlyph agent={agent} size={11} />}
      <span className="truncate font-mono text-2xs">{model}</span>
    </span>
  );
}

/** The Project, with the dot that is its identity everywhere on the board. */
export function ProjectMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-secondary-foreground",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", hueFor(name))} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A +/− pair. Tabular, so the column does not jitter between rows. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
      <span className="text-[var(--atlas-diff-added-text)]">+{added}</span>
      {/* U+2212 MINUS, not a hyphen: it lines up with the plus. */}
      <span className="text-[var(--atlas-diff-removed-text)]">−{removed}</span>
    </span>
  );
}

/** The comment count on a row, when the Session has any. */
export function CommentMarker({ count }: { count: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
      <MessageSquare size={11} />
      <span className="tabular-nums">{count > 99 ? "99+" : count}</span>
    </span>
  );
}

/** The day's spend, a hairline, then who worked that day. */
export function DayMeta({
  sessions,
  directory,
}: {
  sessions: BoardSession[];
  directory: AuthorDirectory;
}) {
  const tokens = sessions.reduce((a, s) => a + s.totalTokens, 0);
  const people = [...new Set(sessions.map((s) => s.authorId))];
  return (
    <span className="flex shrink-0 items-center gap-2.5 pb-0.5">
      {tokens > 0 && (
        <>
          <span className="font-mono text-2xs text-muted-foreground">
            {formatTokens(tokens)} tok
          </span>
          <span aria-hidden className="h-3 w-px bg-border" />
        </>
      )}
      {/* Overlapped, and the ring is the page behind them — a stack reads as
          "these people" where a row of separate faces reads as a list. */}
      <span className="flex items-center -space-x-1.5">
        {people.slice(0, 4).map((id) => {
          const a = authorOf(id, directory);
          return a.avatar ? (
            <span key={id ?? "self"} className="rounded-full ring-2 ring-background">
              <AccountAvatar user={a.avatar} size={16} />
            </span>
          ) : null;
        })}
      </span>
    </span>
  );
}
