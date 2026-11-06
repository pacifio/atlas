// Small pieces every Memory view draws an entry with, props-only: the kind's
// glyph, who wrote it, and the one meta line under it.

import { Brain, UserRound, Download } from "lucide-react";
import { AgentGlyph } from "@/components/brand-marks";
import { useAgentMeta } from "@/features/agents/lib/agent-meta-context";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Badge } from "@tryatlas/design";
import { KIND_ICON } from "../../lib/memory-kind-icon";
import { kindNoun, showsConfidence, usesLabel } from "../../lib/memory-entries";
import { pluginIdForSource } from "../../lib/memory-agent";
import { confidenceLabel, type MemoryEntry } from "../../lib/shared-memory-format";

/** The kind's glyph, with its noun as the accessible name. */
export function KindGlyph({ kind, className }: { kind: string; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Brain;
  return (
    <span title={kindNoun(kind)} className={cn("inline-flex shrink-0", className)}>
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{kindNoun(kind)}</span>
    </span>
  );
}

/** An agent's mark and resolved name, from a memory-corpus source spelling. */
export function AgentName({ agent, strong }: { agent: string; strong?: boolean }) {
  const id = pluginIdForSource(agent);
  const meta = useAgentMeta(id);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AgentGlyph agentType={id} />
      <span className={cn("truncate", strong && "font-medium text-foreground")}>{meta.label}</span>
    </span>
  );
}

/** Who wrote an entry: the agent, you, or an import. */
export function EntryAuthor({ entry: e, strong }: { entry: MemoryEntry; strong?: boolean }) {
  if (e.source === "user" || e.agent === "user") {
    return (
      <span className="inline-flex items-center gap-1">
        <UserRound aria-hidden className="size-3" />
        <span className={cn(strong && "font-medium text-foreground")}>You</span>
      </span>
    );
  }
  if (e.source.startsWith("import:")) {
    return (
      <span className="inline-flex items-center gap-1">
        <Download aria-hidden className="size-3" />
        <span className={cn(strong && "font-medium text-foreground")}>
          Imported from {e.source.slice("import:".length)}
        </span>
      </span>
    );
  }
  return e.agent ? <AgentName agent={e.agent} strong={strong} /> : <span>{e.source || "—"}</span>;
}

/** An entry's state when it is not plainly active. */
export function StateBadge({ state }: { state: MemoryEntry["state"] }) {
  if (state === "candidate") {
    return (
      <Badge variant="warning" size="sm">
        Unconfirmed
      </Badge>
    );
  }
  if (state === "archived") {
    return (
      <Badge variant="secondary" size="sm">
        Archived
      </Badge>
    );
  }
  return null;
}

/** The line under an entry: who, when, how often it is used, how sure the
 *  record is, and its state. Each part is dropped when it says nothing. */
export function EntryMeta({ entry: e, className }: { entry: MemoryEntry; className?: string }) {
  const uses = usesLabel(e.uses);
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0 shrink truncate">
        <EntryAuthor entry={e} />
      </span>
      <Dot />
      <time
        className="shrink-0 tabular-nums"
        dateTime={new Date(e.updatedAt).toISOString()}
        title={new Date(e.updatedAt).toLocaleString()}
      >
        {timeAgo(new Date(e.updatedAt).toISOString(), { suffix: true })}
      </time>
      {uses && (
        <>
          <Dot />
          <span className="shrink-0 tabular-nums">{uses}</span>
        </>
      )}
      {showsConfidence(e) && (
        <>
          <Dot />
          <span className="shrink-0 tabular-nums" title="How sure the record is of this">
            {confidenceLabel(e.confidence)} sure
          </span>
        </>
      )}
      <StateBadge state={e.state} />
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-disabled">
      ·
    </span>
  );
}
