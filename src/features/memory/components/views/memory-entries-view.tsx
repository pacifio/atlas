// The Memories tab, props-only: what agents know about this project, grouped
// by kind, beside a companion pane that is either the chosen memory or an
// overview of the whole record. The list is the front door of the module:
// a person opens Memory to see what the agents believe, and to fix or forget
// what is wrong, so every entry reads at a glance and the fix is one click
// away in the pane.
//
// Under a narrow panel the pane is not shown until a memory is chosen, and
// then it covers the list with a way back.

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ArrowUp, Brain, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, EmptyState, Segmented, Skeleton } from "@tryatlas/design";
import type { EntryGroup, EntryScope } from "../../lib/memory-entries";
import { exportable, type MemoryEntry } from "../../lib/shared-memory-format";
import { EntryMeta, KindGlyph } from "./memory-entry-parts";
import { FilterMenu } from "./shared-memory-primitives";
import { Notice, SearchAskField } from "./memory-chrome";
import type { AgentContext } from "@/features/ask-agent/lib/agent-context";
import {
  ASK_ROW,
  AskAgentButton,
  FixWithAgentButton,
} from "@/features/ask-agent/components/ask-agent-button";

export interface MemoryEntriesViewProps {
  loaded: boolean;
  /** The record could not be read; the list says so instead of "empty". */
  error: string | null;
  onRetry: () => void;
  /** Every entry in either scope; drives the empty state and the counts. */
  total: { current: number; archived: number };
  groups: EntryGroup[];
  scope: EntryScope;
  onScopeChange: (scope: EntryScope) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** The search field's ⌘↵: the typed words, as a memory instruction. */
  onAsk: (text: string, anchor: HTMLElement) => void;
  askKeys: readonly string[];
  agentFilter: string;
  agentOptions: string[];
  formatAgent: (agent: string) => string;
  onAgentFilterChange: (agent: string) => void;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Export mode: exportable rows grow a checkbox, and a bar offers the export. */
  selecting: boolean;
  picked: ReadonlySet<number>;
  pickedCount: number;
  onPick: (id: number) => void;
  onExport: () => void;
  onCancelSelecting: () => void;
  onImportClaude: () => void;
  /** What a row's hover "Ask agent" hands the agent. */
  askContext: (entry: MemoryEntry) => AgentContext[];
  /** The chosen entry's detail, or the overview. */
  pane: ReactNode;
  /** Slots for dialogs the container owns. */
  dialogs?: ReactNode;
  listRef?: Ref<HTMLDivElement>;
}

export function MemoryEntriesView(props: MemoryEntriesViewProps) {
  const {
    loaded,
    error,
    onRetry,
    total,
    groups,
    scope,
    onScopeChange,
    query,
    onQueryChange,
    onAsk,
    askKeys,
    agentFilter,
    agentOptions,
    formatAgent,
    onAgentFilterChange,
    selectedId,
    onSelect,
    selecting,
    pickedCount,
    onExport,
    onCancelSelecting,
    onImportClaude,
    pane,
    dialogs,
  } = props;
  const flat = groups.flatMap((g) => g.entries);
  const asideRef = useRef<HTMLElement>(null);
  // Whether the pane covers the list (a narrow panel). Then the list leaves
  // the tab order while it is covered, focus moves into the pane, and it
  // comes back to the row when the pane closes.
  const [covering, setCovering] = useState(false);
  const lastSelected = useRef<number | null>(null);
  useEffect(() => {
    const aside = asideRef.current;
    if (selectedId !== null) {
      lastSelected.current = selectedId;
      const covers = !!aside && getComputedStyle(aside).position === "absolute";
      setCovering(covers);
      if (covers) aside.focus({ preventScroll: true });
      return;
    }
    setCovering((was) => {
      if (was && lastSelected.current !== null) {
        const id = lastSelected.current;
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(`[data-entry-id="${id}"] > button`)?.focus(),
        );
      }
      return false;
    });
  }, [selectedId]);
  // The panel can change width under an open memory: whether the pane
  // covers the list follows it (without moving focus).
  useEffect(() => {
    const aside = asideRef.current;
    const box = aside?.parentElement;
    if (selectedId === null || !aside || !box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setCovering(getComputedStyle(aside).position === "absolute"),
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [selectedId]);
  const filtered = query.trim() !== "" || agentFilter !== "";
  const nothingAtAll = loaded && !error && total.current + total.archived === 0;

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const at = flat.findIndex((e) => e.id === selectedId);
    const next = flat[Math.max(0, Math.min(flat.length - 1, at === -1 ? 0 : at + delta))];
    onSelect(next.id);
    // Keep the chosen row's button focused, so the keys keep working and a
    // screen reader follows.
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-entry-id="${next.id}"] > button`)
        ?.focus({ preventScroll: false }),
    );
  };

  return (
    <div className="@container/memories flex h-full min-h-0 flex-col bg-background">
      {dialogs}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <SearchAskField
          value={query}
          onChange={onQueryChange}
          placeholder="Search what agents remember…"
          label="Search memories"
          askKeys={askKeys}
          onAsk={onAsk}
        />
        <Segmented
          aria-label="Which memories"
          size="sm"
          value={scope}
          onValueChange={onScopeChange}
          options={[
            { value: "current", label: "Current", count: total.current },
            { value: "archived", label: "Archived", count: total.archived },
          ]}
        />
        {agentOptions.length > 1 && (
          <FilterMenu
            label="Agent"
            value={agentFilter}
            options={agentOptions}
            onChange={onAgentFilterChange}
            format={formatAgent}
          />
        )}
      </div>

      {selecting && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <span className="text-xs text-secondary-foreground">
            {pickedCount === 0
              ? "Pick the memories to write into AGENTS.md"
              : `${pickedCount} picked for AGENTS.md`}
          </span>
          <span className="ml-auto" />
          <Button variant="ghost" size="sm" onClick={onCancelSelecting}>
            Cancel
          </Button>
          <Button size="sm" disabled={pickedCount === 0} onClick={onExport}>
            Preview export
          </Button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={props.listRef}
          inert={covering || undefined}
          className="min-w-0 flex-1 overflow-y-auto"
          onKeyDown={(e) => {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowDown" || e.key === "j") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || e.key === "k") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Escape" && selectedId !== null) {
              onSelect(null);
            }
          }}
        >
          {!loaded ? (
            <ListGhost />
          ) : error ? (
            <Notice
              title="Couldn't read this project's memory"
              action={
                <>
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    Try again
                  </Button>
                  <FixWithAgentButton
                    error={{ kind: "error", source: "Memory: reading the record", message: error }}
                  />
                </>
              }
            >
              <span className="font-mono text-2xs break-words">{error}</span>
            </Notice>
          ) : nothingAtAll ? (
            <EmptyState
              className="h-full"
              icon={Brain}
              title="Nothing remembered here yet"
              description="As agents decide, learn and hit dead ends in this project, what they record shows up here, with the session it came from."
              action={
                <Button size="sm" variant="outline" onClick={onImportClaude}>
                  Import Claude's memory
                </Button>
              }
            />
          ) : groups.length === 0 ? (
            <EmptyState
              className="h-full"
              icon={Search}
              title={
                filtered
                  ? "No memory matches"
                  : scope === "archived"
                    ? "Nothing archived"
                    : "No current memories"
              }
              description={
                filtered
                  ? "Try fewer words, or another agent."
                  : scope === "archived"
                    ? "Memories you dismiss or mark wrong are kept here, with their history."
                    : "Everything this project remembers has been archived."
              }
              action={
                filtered ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onQueryChange("");
                      onAgentFilterChange("");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="mx-1 pb-6">
              {groups.map((g) => (
                <section key={g.kind} aria-labelledby={`memory-group-${g.kind}`}>
                  <GroupHeader
                    id={`memory-group-${g.kind}`}
                    label={g.label}
                    count={g.entries.length}
                  />
                  <div role="list" aria-labelledby={`memory-group-${g.kind}`}>
                    {g.entries.map((e) => (
                      <EntryRow
                        key={e.id}
                        entry={e}
                        selected={selectedId === e.id}
                        onSelect={() => onSelect(selectedId === e.id ? null : e.id)}
                        selecting={selecting}
                        picked={props.picked.has(e.id)}
                        onPick={() => props.onPick(e.id)}
                        askContext={props.askContext}
                      />
                    ))}
                  </div>
                </section>
              ))}
              <p className="flex items-center justify-center gap-1 pt-4 text-2xs text-disabled">
                <ArrowUp aria-hidden className="size-2.5" />
                <ArrowDown aria-hidden className="size-2.5" />
                to move through memories
              </p>
            </div>
          )}
        </div>

        {/* No pane while the record is unread, unreadable or empty: an
            overview of "0 memories" there would contradict the list's own
            state. */}
        {loaded && !error && !nothingAtAll && (
          <aside
            ref={asideRef}
            tabIndex={-1}
            aria-label={selectedId === null ? "Overview" : "Memory detail"}
            className={cn(
              "flex min-h-0 flex-col overflow-y-auto border-l outline-none border-border-subtle bg-background",
              // A companion pane beside the list when there is room for both;
              // below that, only a chosen memory shows, over the list.
              "@3xl/memories:relative @3xl/memories:flex @3xl/memories:w-95 @3xl/memories:shrink-0",
              selectedId === null ? "hidden" : "absolute inset-0 border-l-0 @3xl/memories:border-l",
            )}
          >
            {pane}
          </aside>
        )}
      </div>
    </div>
  );
}

function GroupHeader({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <div className="flex h-8 items-end gap-2 px-2 pb-1 text-2xs font-medium text-muted-foreground">
      <h3 id={id} className="shrink-0">
        {label}
      </h3>
      <span className="shrink-0 tabular-nums text-disabled">{count}</span>
      <span aria-hidden className="mb-1.5 h-px min-w-2 flex-1 bg-border-subtle" />
    </div>
  );
}

/** One memory: its kind, its words (two lines at most) and who wrote it. A
 *  stretched button under the content opens it; the export checkbox and the
 *  hover "Ask agent" take the pointer back. */
function EntryRow({
  entry: e,
  selected,
  onSelect,
  selecting,
  picked,
  onPick,
  askContext,
}: {
  entry: MemoryEntry;
  selected: boolean;
  onSelect: () => void;
  selecting: boolean;
  picked: boolean;
  onPick: () => void;
  askContext: (entry: MemoryEntry) => AgentContext[];
}) {
  const canPick = selecting && exportable(e);
  return (
    <div
      role="listitem"
      data-entry-id={e.id}
      className={cn(
        ASK_ROW,
        "relative flex min-w-0 items-start gap-2.5 rounded px-2 py-2",
        "transition-colors duration-fast ease-out-strong",
        selected
          ? "bg-element-selected"
          : "hover:bg-element-hover has-[>button:focus-visible]:bg-element-hover",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={e.content || "Empty memory"}
        className="absolute inset-0 cursor-pointer rounded focus-visible:outline-none"
      />
      {canPick ? (
        <input
          type="checkbox"
          checked={picked}
          onChange={onPick}
          aria-label={`Pick ${e.content}`}
          className="relative mt-0.5 size-3.5 shrink-0 cursor-pointer accent-foreground"
        />
      ) : (
        <KindGlyph
          kind={e.kind}
          className={cn(
            "pointer-events-none relative mt-0.5",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        />
      )}
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span
          className={cn(
            "line-clamp-2 text-sm leading-snug",
            e.state === "archived" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {e.content || <span className="text-disabled">—</span>}
        </span>
        <EntryMeta entry={e} className="mt-1" />
      </span>
      {!selecting && <AskAgentButton context={askContext(e)} className="relative shrink-0" />}
    </div>
  );
}

function ListGhost() {
  return (
    <div role="status" aria-busy aria-label="Loading memories" className="space-y-3 px-3 py-4">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="size-3.5" />
          <div className="flex-1 space-y-1.5">
            <Skeleton
              className={cn("h-3", i % 3 === 0 ? "w-4/5" : i % 3 === 1 ? "w-3/5" : "w-2/3")}
            />
            <Skeleton className="h-2.5 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}
