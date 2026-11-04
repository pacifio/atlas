import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Badge, SegmentMeter } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { Bar, useCountUp, useMounted } from "@/components/usage-primitives";
import { fmtCost, fmtTokens } from "@/features/monitor/lib/usage-format";
import type {
  ContextStatus,
  MetricRow,
  RateLimitWindow,
  SessionUsageView,
} from "../../lib/session-usage";

/**
 * The Usage popup's content — the analytics-card reading of one session.
 *
 * Nested rounded cards inside the dropup: a big headline number with a
 * caption and a status badge over a tick meter, then token rows with inline
 * bars, cost, quota bars and a session grid. Sections are conditional on the
 * view: what is not known is not drawn, so a Codex session (context only) is
 * one card, a Claude session after a turn is the full stack. Nothing here
 * names the agent or the model — the pills beside the composer already do.
 *
 * Rendered only while the panel is open. The stagger is a one-shot CSS
 * animation (`atlas-usage-in`) that replays on each open because the
 * sections mount fresh; the count-up and the bars settle inside 220 ms.
 */

const VALUE = "text-xs tnum text-foreground";
const HERO = "text-2xl leading-none font-semibold tnum text-foreground";

/** One staggered section card; `index` drives the `atlas-usage-in` delay. */
function Section({
  index,
  section,
  children,
}: {
  index: number;
  section: string;
  children: ReactNode;
}) {
  return (
    <section
      data-section={section}
      className="atlas-usage-in rounded-lg bg-card px-2.5 py-2 ring-1 ring-foreground/10"
      style={{ "--i": index } as CSSProperties}
    >
      {children}
    </section>
  );
}

const STATUS: Record<
  ContextStatus,
  { variant: "secondary" | "warning" | "destructive"; label: string }
> = {
  ok: { variant: "secondary", label: "OK" },
  warn: { variant: "warning", label: "Warn" },
  full: { variant: "destructive", label: "Full" },
};

function StatusBadge({ status }: { status: ContextStatus }) {
  const { variant, label } = STATUS[status];
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

/** The "est." mark beside any cost that came from the price map, not the provider. */
function EstBadge() {
  return (
    <Badge size="sm" variant="outline">
      est.
    </Badge>
  );
}

function Headline({ view }: { view: SessionUsageView }) {
  const h = view.headline;
  const target = !h ? 0 : h.kind === "context" ? h.pct : h.kind === "tokens" ? h.total : h.amount;
  const value = useCountUp(target);
  if (!h) return null;
  if (h.kind === "context") {
    return (
      <Section index={0} section="context">
        <div className="eyebrow">
          Context · {fmtTokens(h.used)} / {fmtTokens(h.size)}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className={HERO}>
            {value.toFixed(value >= 10 ? 0 : 1)}
            <span className="ml-0.5 text-md font-medium text-muted-foreground">%</span>
          </span>
          <StatusBadge status={h.status} />
        </div>
        <SegmentMeter
          variant="gauge"
          value={h.pct / 100}
          label="Context window"
          className="mt-2.5"
        />
        <div className="mt-1 flex justify-between text-3xs font-medium tracking-wider text-muted-foreground uppercase">
          <span>0</span>
          <span>{fmtTokens(h.size)}</span>
        </div>
        {view.compacting ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-primary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            Compacting the context window…
          </div>
        ) : view.savedTokens ? (
          <div className="caption mt-1.5">
            Compression saved {fmtTokens(view.savedTokens)} tokens
          </div>
        ) : null}
      </Section>
    );
  }
  if (h.kind === "tokens") {
    return (
      <Section index={0} section="tokens-total">
        <div className="eyebrow">Tokens · this session</div>
        <div className={cn("mt-1", HERO)}>{fmtTokens(Math.round(value))}</div>
      </Section>
    );
  }
  return (
    <Section index={0} section="cost-total">
      <div className="eyebrow">Cost · this session{h.estimated ? " · est." : ""}</div>
      <div className={cn("mt-1", HERO)}>{fmtCost(value, h.currency)}</div>
    </Section>
  );
}

function TokenRows({ rows, index }: { rows: MetricRow[]; index: number }) {
  const mounted = useMounted();
  return (
    <Section index={index} section="tokens">
      <div className="eyebrow mb-1">Tokens</div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.key} className="flex h-6 items-center gap-2.5">
            <span className="w-[76px] shrink-0 truncate text-xs text-secondary-foreground">
              {r.label}
            </span>
            <span className="min-w-0 flex-1">
              <Bar frac={r.frac} mounted={mounted} />
            </span>
            <span className={cn("w-[48px] shrink-0 text-right", VALUE)}>{fmtTokens(r.value)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Cost({ cost, index }: { cost: NonNullable<SessionUsageView["cost"]>; index: number }) {
  return (
    <Section index={index} section="cost">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Cost</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-lg leading-none font-semibold tnum text-foreground">
            {fmtCost(cost.total, cost.currency)}
          </span>
          {cost.estimated ? <EstBadge /> : null}
        </span>
      </div>
      {cost.rows.length ? (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {cost.rows.map((r) => (
            <div key={r.key} className="flex items-baseline justify-between">
              <span className="text-2xs text-muted-foreground">{r.label}</span>
              <span className="text-2xs tnum text-secondary-foreground">
                {fmtCost(r.cost ?? 0, cost.currency)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function resetsIn(w: RateLimitWindow, now: number): string | null {
  if (!w.resetsAt) return null;
  const s = Math.max(0, w.resetsAt - Math.floor(now / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function windowLabel(w: RateLimitWindow, fallback: string): string {
  if (!w.windowMinutes) return fallback;
  return w.windowMinutes >= 1440
    ? `${Math.round(w.windowMinutes / 1440)}-day limit`
    : `${Math.round(w.windowMinutes / 60)}-hour limit`;
}

function QuotaRow({
  label,
  window: w,
  now,
  mounted,
}: {
  label: string;
  window: RateLimitWindow;
  now: number;
  mounted: boolean;
}) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const when = resetsIn(w, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-secondary-foreground">{label}</span>
        <span className={VALUE}>
          {Math.round(pct)}%
          {when ? <span className="ml-1.5 text-2xs text-muted-foreground">{when}</span> : null}
        </span>
      </div>
      {/* The package `Progress` has no tone for its indicator, and a quota bar
          must carry its status colour, so every bar here stays on the shared
          usage `Bar` (the token rows too, so the two read as one set). */}
      <Bar
        frac={pct / 100}
        mounted={mounted}
        color={
          pct >= 90
            ? "var(--status-error-foreground)"
            : pct >= 70
              ? "var(--status-warning-foreground)"
              : "var(--status-success-foreground)"
        }
      />
    </div>
  );
}

function Quota({ quota, index }: { quota: NonNullable<SessionUsageView["quota"]>; index: number }) {
  const mounted = useMounted();
  // A clock for the countdowns, ticking while this card is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Section index={index} section="quota">
      <div className="eyebrow mb-1.5 flex justify-between">
        <span>Quota</span>
        {quota.plan ? <span>{quota.plan}</span> : null}
      </div>
      <div className="flex flex-col gap-2">
        {quota.primary ? (
          <QuotaRow
            label={windowLabel(quota.primary, "Current window")}
            window={quota.primary}
            now={now}
            mounted={mounted}
          />
        ) : null}
        {quota.secondary ? (
          <QuotaRow
            label={windowLabel(quota.secondary, "Longer window")}
            window={quota.secondary}
            now={now}
            mounted={mounted}
          />
        ) : null}
      </div>
    </Section>
  );
}

function fmtActive(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Session({
  session,
  index,
}: {
  session: NonNullable<SessionUsageView["session"]>;
  index: number;
}) {
  const cells: Array<[string, ReactNode]> = [];
  if (session.turns !== null) cells.push(["Turns", session.turns]);
  if (session.messages !== null) cells.push(["Messages", session.messages]);
  if (session.toolCalls !== null) cells.push(["Tool calls", session.toolCalls]);
  if (session.filesTouched !== null) cells.push(["Files touched", session.filesTouched]);
  if (session.insertions !== null || session.deletions !== null) {
    cells.push([
      "Lines",
      <span key="lines">
        <span className="text-success">+{session.insertions ?? 0}</span>
        <span className="mx-0.5 text-muted-foreground">/</span>
        <span className="text-error">−{session.deletions ?? 0}</span>
      </span>,
    ]);
  }
  if (session.activeSeconds !== null) cells.push(["Active", fmtActive(session.activeSeconds)]);
  if (session.checkpoints !== null) cells.push(["Checkpoints", session.checkpoints]);
  if (!cells.length) return null;
  return (
    <Section index={index} section="session">
      <div className="eyebrow mb-1">Session</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {cells.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <span className="text-2xs text-muted-foreground">{label}</span>
            <span className={VALUE}>{value}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function UsagePopupView({ view }: { view: SessionUsageView }) {
  let index = 0;
  const next = () => ++index;
  const empty = !view.headline && !view.tokens && !view.cost && !view.quota && !view.session;

  return (
    <div data-usage-popup className="flex flex-col gap-1.5 p-1.5">
      {empty ? (
        <Section index={0} section="empty">
          <div className="label">Nothing yet</div>
          <p className="caption mt-0.5">
            Usage shows up after the first turn — what this agent reports, and what Atlas records.
          </p>
        </Section>
      ) : (
        <>
          <Headline view={view} />
          {view.tokens ? <TokenRows rows={view.tokens} index={next()} /> : null}
          {view.cost ? <Cost cost={view.cost} index={next()} /> : null}
          {view.quota ? <Quota quota={view.quota} index={next()} /> : null}
          {view.session ? <Session session={view.session} index={next()} /> : null}
        </>
      )}
    </div>
  );
}
