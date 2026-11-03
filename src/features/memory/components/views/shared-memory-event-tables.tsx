import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { agentMetaForSource } from "../../lib/memory-agent";
import { cn } from "@/lib/utils";
import {
  eventDetail,
  eventTime,
  fmtDateTime,
  str,
  type MemoryEvent,
} from "../../lib/shared-memory-format";
import {
  AgentTag,
  EmptyRows,
  HeaderRow,
  KindChip,
  MetaChip,
  StatusChip,
} from "./shared-memory-primitives";
import { DETAIL_TEXT, DETAIL_WELL, ROW_DETAIL, TABLE_ROW, rowButton } from "./memory-chrome";

/* ── Column tracks (sticky header + rows line up; min-width → horizontal scroll) ── */
const EVENT_COL = {
  seq: "w-[56px] shrink-0",
  time: "w-[92px] shrink-0",
  agent: "w-[128px] shrink-0",
  kind: "w-[136px] shrink-0",
  detail: "flex-1 min-w-[260px]",
  chevron: "w-[30px] shrink-0",
} as const;
const EVENT_MIN_W = 56 + 92 + 128 + 136 + 260 + 30;

const PLAN_COL = {
  seq: "w-[56px] shrink-0",
  time: "w-[92px] shrink-0",
  agent: "w-[128px] shrink-0",
  status: "w-[110px] shrink-0",
  plan: "flex-1 min-w-[280px]",
  chevron: "w-[30px] shrink-0",
} as const;
const PLAN_MIN_W = 56 + 92 + 128 + 110 + 280 + 30;

/* ── Events table ────────────────────────────────────────────────────────────── */

export function EventsTable({ rows }: { rows: MemoryEvent[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      <div style={{ minWidth: EVENT_MIN_W }}>
        <HeaderRow>
          <span className={cn(EVENT_COL.seq, "tabular-nums")}>#</span>
          <span className={EVENT_COL.time}>Time</span>
          <span className={EVENT_COL.agent}>Agent</span>
          <span className={EVENT_COL.kind}>Kind</span>
          <span className={EVENT_COL.detail}>Detail</span>
          <span className={EVENT_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No events match." />
        ) : (
          rows.map((e) => (
            <EventRow
              key={e.seq}
              event={e}
              expanded={expanded === e.seq}
              onToggle={() => setExpanded((c) => (c === e.seq ? null : e.seq))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EventRow({
  event: e,
  expanded,
  onToggle,
}: {
  event: MemoryEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={TABLE_ROW}>
      <button onClick={onToggle} className={rowButton(expanded)}>
        <span className={cn(EVENT_COL.seq, "font-mono text-2xs tabular-nums text-disabled")}>
          {e.seq}
        </span>
        <span className={cn(EVENT_COL.time, "caption tabular-nums")}>{eventTime(e.ts)}</span>
        <span className={EVENT_COL.agent}>
          <AgentTag agent={e.agent} />
        </span>
        <span className={EVENT_COL.kind}>
          <KindChip kind={e.kind} />
        </span>
        <span className={cn(EVENT_COL.detail, "min-w-0 pr-3")}>
          <span className="block truncate text-sm text-foreground">
            {eventDetail(e) || <span className="text-disabled">—</span>}
          </span>
        </span>
        <span
          className={cn(EVENT_COL.chevron, "flex items-center justify-end text-muted-foreground")}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && <EventDetail event={e} />}
    </div>
  );
}

function EventDetail({ event: e }: { event: MemoryEvent }) {
  const detail = eventDetail(e);
  return (
    <div className={ROW_DETAIL}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MetaChip label="Seq" value={`#${e.seq}`} mono />
        <MetaChip label="Kind" value={e.kind.replace(/_/g, " ")} />
        <MetaChip label="Agent" value={agentMetaForSource(e.agent).label} />
        {e.key && <MetaChip label="Key" value={e.key} mono />}
        <MetaChip label="When" value={fmtDateTime(e.ts)} />
        {e.sessionId && <MetaChip label="Session" value={e.sessionId.slice(0, 8)} mono />}
      </div>
      {detail && (
        <div className={DETAIL_WELL}>
          <pre className={DETAIL_TEXT}>{detail}</pre>
        </div>
      )}
    </div>
  );
}

/* ── Plans table ─────────────────────────────────────────────────────────────── */

export function PlansTable({ rows }: { rows: MemoryEvent[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      <div style={{ minWidth: PLAN_MIN_W }}>
        <HeaderRow>
          <span className={cn(PLAN_COL.seq, "tabular-nums")}>#</span>
          <span className={PLAN_COL.time}>Time</span>
          <span className={PLAN_COL.agent}>Agent</span>
          <span className={PLAN_COL.status}>Status</span>
          <span className={PLAN_COL.plan}>Plan</span>
          <span className={PLAN_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No plans captured yet." />
        ) : (
          rows.map((e) => (
            <PlanRow
              key={e.seq}
              event={e}
              expanded={expanded === e.seq}
              onToggle={() => setExpanded((c) => (c === e.seq ? null : e.seq))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PlanRow({
  event: e,
  expanded,
  onToggle,
}: {
  event: MemoryEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const text = str(e.payload?.text);
  const status = str(e.payload?.status) || "active";
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className={TABLE_ROW}>
      <button onClick={onToggle} className={rowButton(expanded)}>
        <span className={cn(PLAN_COL.seq, "font-mono text-2xs tabular-nums text-disabled")}>
          {e.seq}
        </span>
        <span className={cn(PLAN_COL.time, "caption tabular-nums")}>{eventTime(e.ts)}</span>
        <span className={PLAN_COL.agent}>
          <AgentTag agent={e.agent} />
        </span>
        <span className={PLAN_COL.status}>
          <StatusChip status={status} />
        </span>
        <span className={cn(PLAN_COL.plan, "min-w-0 pr-3")}>
          <span className="block truncate text-sm text-foreground">
            {firstLine || <span className="text-disabled">—</span>}
          </span>
        </span>
        <span
          className={cn(PLAN_COL.chevron, "flex items-center justify-end text-muted-foreground")}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && (
        <div className={ROW_DETAIL}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <MetaChip label="Seq" value={`#${e.seq}`} mono />
            <MetaChip label="Status" value={status} />
            <MetaChip label="Agent" value={agentMetaForSource(e.agent).label} />
            <MetaChip label="When" value={fmtDateTime(e.ts)} />
          </div>
          <div className={DETAIL_WELL}>
            <pre className={DETAIL_TEXT}>{text || "—"}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
