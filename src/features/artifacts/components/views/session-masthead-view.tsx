import type { ReactNode } from "react";
import { Download, GitCommitHorizontal, GitPullRequest, TriangleAlert } from "lucide-react";

import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { SecuritySummary } from "@/features/security/components/security-summary";
import {
  ShipOverviewCard,
  type BranchPullRequest,
} from "@/features/security/components/ship-overview-card";

import { useAgentMetaResolver } from "@/features/agents/lib/agent-meta-context";

import type { SessionDetail as Detail } from "../../types";
import {
  agentLabel,
  formatDuration,
  prettyModel,
  sessionState,
  sessionTitle,
  tokenBreakdown,
  tokenLabel,
} from "../../lib/board";
import type { RowComments } from "../../lib/session-detail-context";
import { clock, costLabel } from "../../lib/session-timeline";
import { AgentGlyph } from "../agent-glyph";
import { CommentButton } from "../comment-thread";
import { ContextMeter } from "../context-meter";

/**
 * The masthead as drawn: title, identity pills and the four-cell grid. The
 * container (`session-masthead.tsx`) resolves the open PR, the price and the
 * thread's open signal; this only lays them out.
 */
export function SessionMastheadView({
  detail,
  comments,
  projectPath,
  openSignal,
  pr,
  cost,
  spent,
}: {
  detail: Detail;
  comments: RowComments | null;
  projectPath: string;
  /** The Session thread's open signal — see `useOpenSignal`. */
  openSignal: number | undefined;
  pr: BranchPullRequest | null;
  /** Estimated cost, or `null` when there is no price or no token split. */
  cost: number | null;
  /** Every token the Session spent, across all four kinds. */
  spent: number;
}) {
  const s = detail.summary;
  const branch = s.branches[0];
  const tokens = tokenLabel(s);

  /**
   * Why the missing cells are drawn rather than dropped.
   *
   * Every live ACP session reports context occupancy and nothing else — no
   * split, no cache figures — so two of the four cells have nothing to say.
   * Rendering the grid two-wide for those was worse than the hole it avoided:
   * two cells stretched across the measure read as a layout that had broken,
   * and the row changed shape between Sessions. They keep their place, say
   * what is missing, and the grid is the same object every time.
   */

  return (
    <>
      {/* `group/row` so the session thread's button reveals on the same hover
       *  rule as every other one — it is the same control, at Session scope. */}
      <div className="group/row flex items-start gap-2">
        <h1 className="min-w-0 flex-1 text-xl font-semibold leading-[1.25] tracking-[-0.02em] text-[var(--foreground)]">
          {sessionTitle(s.title) ?? (
            <span className="text-[var(--muted-foreground)]">Untitled session</span>
          )}
        </h1>
        {/* The whole-Session thread, for anything that is not about one step. */}
        {comments && (
          <CommentButton
            anchorKind="session"
            anchorId={s.id}
            comments={comments.session}
            actions={comments.actions}
            directory={comments.directory}
            label="Comment on this Session"
            className="mt-1 group-hover/row:opacity-100"
            openSignal={openSignal}
          />
        )}
      </div>

      <div className="mt-[22px] flex min-w-0 flex-wrap items-center gap-2">
        {sessionState(s) === "live" && <LiveChip />}
        {s.agent && <AgentChip agent={s.agent} />}
        {s.source === "external_jsonl" && (
          <Chip>
            <Download size={11} />
            imported
          </Chip>
        )}
        {branch && (
          <Chip>
            <GitCommitHorizontal size={11} />
            {branch}
          </Chip>
        )}
        {pr !== null && (
          <Chip>
            <GitPullRequest size={11} />
            PR #{pr.number} open
          </Chip>
        )}
        <span className="font-mono text-xs text-[var(--muted-foreground)]">
          {timeAgo(s.lastActivityAt, { suffix: true })} · {formatDuration(s.activeSeconds)}
        </span>
        {s.needsAttention && (
          <span
            className="flex h-[22px] items-center gap-1.5 rounded-full border border-warning/25 bg-warning-muted px-2.5 font-mono text-xs text-warning"
            title={s.attentionReason ?? undefined}
          >
            <TriangleAlert size={11} />
            partial
          </span>
        )}
      </div>

      {branch && <ShipOverviewCard projectPath={projectPath} branch={branch} pr={pr} />}

      <div
        className={cn(
          // 2×2 in the dock, four across when there is room. Four cells over a
          // 620px panel left each one too narrow for its own figure, and the
          // Context bar in particular stopped being readable as a bar.
          //
          // `@4xl` is 728px here, not the 896 it would be on a 16px root —
          // this app's root is 13px, so every container step is proportionally
          // smaller and the breakpoint has to be read in pixels, not in `rem`.
          "mt-[22px] grid grid-cols-2 overflow-hidden rounded-md border border-[var(--border)] @4xl:grid-cols-4",
          "[&>*]:border-[var(--border)] [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t",
          "@4xl:[&>*+*]:border-l @4xl:[&>*:nth-child(n+3)]:border-t-0",
        )}
      >
        <Metric label="Active" value={formatDuration(s.activeSeconds)} sub={clock(s)} />
        <Metric
          label="Tokens"
          value={tokens ?? "—"}
          sub={tokenBreakdown(s) ?? (s.contextUsed != null ? "context window" : "not reported")}
        />
        {/* Context, not the token mix. The mix answered "where did the spend
            go", which the Tokens cell beside it already says in its caption;
            this answers "how close to the window's edge did the run get",
            which nothing else here says and which is the figure that decides
            whether a Session could have continued. */}
        {s.contextUsed != null && s.contextSize ? (
          <Cell label="Context">
            <ContextMeter used={s.contextUsed} size={s.contextSize} />
          </Cell>
        ) : (
          <Metric label="Context" value="—" sub="not reported" absent />
        )}
        {cost == null ? (
          <Metric
            label="Est. cost"
            value="—"
            sub={spent > 0 ? "no price for this model" : "no token split"}
            absent
          />
        ) : (
          <Metric
            label="Est. cost"
            value={costLabel(cost)}
            sub={prettyModel(s.model) ?? "unknown model"}
          />
        )}
      </div>
      <SecuritySummary projectPath={projectPath} sessionId={s.id} />
    </>
  );
}

/** One cell of the grid. The dividers are the grid's, not the cell's. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-[var(--card)] px-3.5 py-3">
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * `absent` is the placeholder state: the figure is not merely zero, it was
 * never reported. It dims the value to the caption's own weight so the cell
 * reads as a held place rather than a number worth looking at.
 */
function Metric({
  label,
  value,
  sub,
  absent,
}: {
  label: string;
  value: string;
  sub: string;
  absent?: boolean;
}) {
  return (
    <Cell label={label}>
      <p
        className={cn(
          "mt-1.5 truncate font-mono text-lg font-medium tracking-[-0.02em]",
          absent ? "text-disabled" : "text-[var(--foreground)]",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate font-mono text-2xs text-disabled">{sub}</p>
    </Cell>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[22px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 font-mono text-xs text-[var(--muted-foreground)]">
      {children}
    </span>
  );
}

/**
 * Still being written: the same breathing green dot as the Session's node on
 * the Timeline, with the word, because a dot alone in a row of grey chips read
 * as decoration. First in the row — it is the one chip that is status.
 */
function LiveChip() {
  return (
    <span className="flex h-[22px] items-center gap-1.5 rounded-full border border-success/25 bg-success-muted px-2.5 font-mono text-xs text-success">
      <span
        aria-hidden
        className="atlas-live-pulse size-1.5 rounded-full bg-success"
        style={{
          ["--atlas-pulse-color" as string]:
            "color-mix(in oklab, var(--status-success-foreground) 40%, transparent)",
        }}
      />
      live
    </span>
  );
}

/**
 * The agent, in monochrome.
 *
 * The composer badges its agent without a brand tint and this row now matches:
 * on a masthead that already carries a title, a branch, a duration and a state
 * chip, a coloured pill was the loudest thing on the line and the least
 * important — the agent is *identity*, not *status*, and the mark alone says it.
 */
function AgentChip({ agent }: { agent: string }) {
  const resolveAgent = useAgentMetaResolver();
  return (
    <Chip>
      <span className="text-[var(--secondary-foreground)]">
        <AgentGlyph agent={agent} mono />
      </span>
      {agentLabel(agent, resolveAgent).toLowerCase()}
    </Chip>
  );
}
