import { useEffect, useState } from "react";
import { prList } from "@/features/pull-requests/lib/pull-requests-api";
import { onSecurityScanChanged, securityShipOverview } from "../lib/security-api";
import { whereLabel } from "../lib/security-levels";
import type { NotScannedFile, ShipOverview } from "../types";
import { SecurityLevelBadge } from "./session-security-badge";

function skipLabel(reason: NotScannedFile["reason"]): string {
  if (typeof reason !== "string") return "too large";
  return (
    {
      binary: "binary",
      generated: "generated",
      deleted_file: "deleted",
      time_budget: "ran out of time",
      unsupported_lockfile: "lockfile not read",
    } as const
  )[reason];
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border px-3.5 py-2">
      <p className="mb-1 text-2xs text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Line({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 font-mono text-xs">
      <span className="min-w-0 truncate text-foreground">{left}</span>
      <span className="shrink-0">{right}</span>
    </div>
  );
}

/**
 * Before you ship: when the session's branch has an open pull request, its
 * scanned checkpoints rolled into one view. Never says the branch is secure;
 * it says what was found, what was fixed, and what was not looked at.
 */
export function ShipOverviewCard({ projectPath, branch }: { projectPath: string; branch: string }) {
  const [pr, setPr] = useState<number | null>(null);
  const [overview, setOverview] = useState<ShipOverview | null>(null);

  useEffect(() => {
    let live = true;
    if (!projectPath || !branch) return;
    // The pull request is looked up again on every stored scan, so a PR
    // opened or closed while the session is on screen shows or hides the card.
    const refresh = async () => {
      const open = (await prList(projectPath, { head: branch, state: "open", limit: 1 }))
        .entries[0];
      if (!live) return;
      setPr(open?.number ?? null);
      if (!open) return;
      const o = await securityShipOverview(projectPath, branch);
      if (live) setOverview(o);
    };
    void refresh().catch(() => {});
    const stop = onSecurityScanChanged((p) => {
      if (p === projectPath) void refresh().catch(() => {});
    });
    return () => {
      live = false;
      void stop.then((f) => f()).catch(() => {});
    };
  }, [projectPath, branch]);

  if (pr === null || !overview) return null;
  return (
    <section
      aria-label="Before you ship"
      className="mt-4 overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <p className="text-sm text-foreground">
          Before you ship <span className="font-mono text-xs text-muted-foreground">PR #{pr}</span>
        </p>
        {overview.blocking ? (
          <SecurityLevelBadge level={overview.level} label="Blocks shipping" />
        ) : overview.open.length === 0 ? (
          <span className="text-2xs text-muted-foreground">No open findings</span>
        ) : (
          <SecurityLevelBadge level={overview.level} />
        )}
      </div>
      {overview.open.length > 0 && (
        <Group
          title={`Open, across ${overview.checkpoints} ${overview.checkpoints === 1 ? "checkpoint" : "checkpoints"}`}
        >
          {overview.open.map((f) => (
            <Line
              key={f.fingerprint}
              left={whereLabel(f)}
              right={<SecurityLevelBadge level={f.level} />}
            />
          ))}
        </Group>
      )}
      {overview.fixed.length > 0 && (
        <Group title="Fixed in a later checkpoint">
          {overview.fixed.map((f) => (
            <Line
              key={`${f.path}:${f.line}:${f.ruleId}`}
              left={whereLabel(f)}
              right={
                <span className="text-success">
                  {f.fixedIn ? `fixed in ${f.fixedIn.slice(0, 7)}` : "fixed"}
                </span>
              }
            />
          ))}
        </Group>
      )}
      {overview.sensitive.length > 0 && (
        <Group title="Sensitive areas changed">
          {overview.sensitive.map((a) => (
            <Line
              key={a.path}
              left={a.path}
              right={<span className="text-muted-foreground">{a.kind}</span>}
            />
          ))}
        </Group>
      )}
      {overview.notScanned.length > 0 && (
        <Group title="Not scanned">
          {overview.notScanned.map((n) => (
            <Line
              key={n.path}
              left={n.path}
              right={<span className="text-muted-foreground">{skipLabel(n.reason)}</span>}
            />
          ))}
        </Group>
      )}
    </section>
  );
}
