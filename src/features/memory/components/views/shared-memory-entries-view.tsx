import type { ReactNode, Ref } from "react";
import { Trash2, ChevronRight, ChevronDown, Check, Pencil, X, Loader2, Eraser } from "lucide-react";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { agentMetaForSource } from "../../lib/memory-agent";
import { cn } from "@/lib/utils";
import {
  KIND_LABEL,
  confidenceLabel,
  entryAgent,
  eventTime,
  exportable,
  fmtDateTime,
  provenanceLine,
  sourceLabel,
  type MemoryEntry,
  type Provenance,
} from "../../lib/shared-memory-format";
import {
  AgentTag,
  EmptyRows,
  HeaderRow,
  IconButton,
  KindChip,
  MetaChip,
  SourceChip,
  StateChip,
} from "./shared-memory-primitives";
import { DETAIL_TEXT, DETAIL_WELL, ROW_DETAIL, TABLE_ROW, rowButton } from "./memory-chrome";
import { Button } from "@/ui/button";

const ENTRY_COL = {
  time: "w-[92px] shrink-0",
  kind: "w-[110px] shrink-0",
  source: "w-[120px] shrink-0",
  agent: "w-[128px] shrink-0",
  confidence: "w-[64px] shrink-0 text-right pr-4",
  content: "flex-1 min-w-[240px]",
  chevron: "w-[30px] shrink-0",
} as const;
const ENTRY_MIN_W = 92 + 110 + 120 + 128 + 64 + 240 + 30;

/* ── Memories table ──────────────────────────────────────────────────────────── */

/** The Memories table body. `MemoriesTable` owns the expand/select state and
 *  passes the export dialog and each row's expanded detail in as slots. */
export function MemoriesTableView({
  scrollerRef,
  rows,
  chosenCount,
  onExport,
  exportModal,
  expandedId,
  onToggleRow,
  selected,
  onSelectRow,
  renderDetail,
}: {
  scrollerRef: Ref<HTMLDivElement>;
  rows: MemoryEntry[];
  /** Picked rows still listed and exportable. */
  chosenCount: number;
  onExport: () => void;
  exportModal: ReactNode;
  expandedId: number | null;
  onToggleRow: (id: number) => void;
  selected: ReadonlySet<number>;
  onSelectRow: (id: number) => void;
  renderDetail: (entry: MemoryEntry) => ReactNode;
}) {
  return (
    <div ref={scrollerRef} className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      {chosenCount > 0 && (
        <div className="flex h-10 items-center gap-2 border-b border-border bg-card px-3">
          <span className="label tabular-nums">{chosenCount} selected</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={onExport}>
            Export to AGENTS.md
          </Button>
        </div>
      )}
      {exportModal}
      <div style={{ minWidth: ENTRY_MIN_W }}>
        <HeaderRow>
          <span className="w-6 shrink-0" />
          <span className={ENTRY_COL.time}>Updated</span>
          <span className={ENTRY_COL.kind}>Kind</span>
          <span className={ENTRY_COL.source}>Source</span>
          <span className={ENTRY_COL.agent}>Agent</span>
          <span className={ENTRY_COL.confidence}>Conf.</span>
          <span className={ENTRY_COL.content}>Memory</span>
          <span className={ENTRY_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No memories match." />
        ) : (
          rows.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              expanded={expandedId === e.id}
              onToggle={() => onToggleRow(e.id)}
              selected={selected.has(e.id)}
              onSelect={() => onSelectRow(e.id)}
              detail={expandedId === e.id ? renderDetail(e) : null}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry: e,
  expanded,
  onToggle,
  selected,
  onSelect,
  detail,
}: {
  entry: MemoryEntry;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  /** The expanded row's detail; rendered only while `expanded`. */
  detail: ReactNode;
}) {
  return (
    <div data-entry-id={e.id} className={TABLE_ROW}>
      <div className="flex items-center">
        <span className="flex w-6 shrink-0 items-center justify-end">
          {exportable(e) && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label={`Select ${e.content}`}
              className="size-3 cursor-pointer accent-foreground"
            />
          )}
        </span>
        <button onClick={onToggle} className={rowButton(expanded, "min-w-0 flex-1")}>
          <span className={cn(ENTRY_COL.time, "caption tabular-nums")}>
            {eventTime(e.updatedAt)}
          </span>
          <span className={ENTRY_COL.kind}>
            <KindChip kind={e.kind} />
          </span>
          <span className={cn(ENTRY_COL.source, "min-w-0 pr-2 flex items-center gap-1")}>
            <SourceChip source={e.source} />
            {e.state && e.state !== "active" && <StateChip state={e.state} />}
          </span>
          <span className={cn(ENTRY_COL.agent, "min-w-0")}>
            {entryAgent(e.agent) ? (
              <AgentTag agent={e.agent} />
            ) : (
              <span className="text-xs text-muted-foreground">{e.agent || "—"}</span>
            )}
          </span>
          <span className={cn(ENTRY_COL.confidence, "caption tabular-nums")}>
            {confidenceLabel(e.confidence)}
          </span>
          <span className={cn(ENTRY_COL.content, "min-w-0 pr-3")}>
            <span className="block truncate text-sm text-foreground">
              {e.content || <span className="text-disabled">—</span>}
            </span>
          </span>
          <span
            className={cn(ENTRY_COL.chevron, "flex items-center justify-end text-muted-foreground")}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
      </div>
      {expanded && detail}
    </div>
  );
}

/** An expanded entry: its full provenance, its content, and the edit and
 *  forget actions. Editing follows the Policy view: a draft, save, revert. */
export function EntryDetailView({
  entry: e,
  editing,
  draft,
  dirty,
  saving,
  provenance,
  confirmForget,
  confirmErase,
  onDraftChange,
  onEdit,
  onSave,
  onCancel,
  onAskForget,
  onAskErase,
  onForget,
  onErase,
  onConfirmForgetChange,
  onConfirmEraseChange,
}: {
  entry: MemoryEntry;
  editing: boolean;
  draft: string;
  dirty: boolean;
  saving: boolean;
  provenance: Provenance[];
  confirmForget: boolean;
  confirmErase: boolean;
  onDraftChange: (draft: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onAskForget: () => void;
  onAskErase: () => void;
  onForget: () => void;
  onErase: () => void;
  onConfirmForgetChange: (open: boolean) => void;
  onConfirmEraseChange: (open: boolean) => void;
}) {
  return (
    <div className={ROW_DETAIL}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MetaChip label="Kind" value={KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")} />
        <MetaChip label="Source" value={sourceLabel(e.source)} />
        <MetaChip
          label="Agent"
          value={entryAgent(e.agent) ? agentMetaForSource(e.agent).label : e.agent || "—"}
        />
        <MetaChip label="Confidence" value={confidenceLabel(e.confidence)} />
        {e.key && <MetaChip label="Key" value={e.key} mono />}
        <MetaChip label="Created" value={fmtDateTime(e.createdAt)} />
        <MetaChip label="Updated" value={fmtDateTime(e.updatedAt)} />
        {e.uses > 0 && <MetaChip label="Uses" value={String(e.uses)} />}
        {e.sessionId && <MetaChip label="Session" value={e.sessionId.slice(0, 8)} mono />}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <IconButton label="Save (⌘Enter)" onClick={onSave}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              </IconButton>
              <IconButton label="Cancel (Esc)" onClick={onCancel}>
                <X size={12} />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton label="Edit memory" onClick={onEdit}>
                <Pencil size={12} />
              </IconButton>
              <IconButton label="Forget memory" onClick={onAskForget}>
                <Trash2 size={12} />
              </IconButton>
              <IconButton label="Erase with history" onClick={onAskErase}>
                <Eraser size={12} />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          value={draft}
          autoFocus
          onChange={(ev) => onDraftChange(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
              ev.preventDefault();
              onSave();
            } else if (ev.key === "Escape") {
              onCancel();
            }
          }}
          spellCheck={false}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          aria-label="Memory content"
          className={cn(
            "block w-full resize-y rounded-md border bg-panel-input px-3 py-2 font-sans text-sm leading-relaxed text-foreground outline-none",
            "transition-colors duration-fast ease-out-strong focus:border-border-strong",
            dirty ? "border-border-strong" : "border-border",
          )}
        />
      ) : (
        <div className={DETAIL_WELL}>
          <pre className={DETAIL_TEXT}>{e.content || "—"}</pre>
        </div>
      )}
      {provenance.length > 0 && (
        <div className="space-y-0.5">
          {provenance.map((p, i) => (
            <p key={`${p.source}-${i}`} className="text-xs text-muted-foreground">
              {provenanceLine(p)}
            </p>
          ))}
        </div>
      )}
      <FileTreeConfirmDelete
        open={confirmForget}
        name={e.content}
        isDir={false}
        title="Forget this memory?"
        body="Every agent on this project stops seeing it, and it no longer shows in search. This can't be undone."
        confirmLabel="Forget"
        onConfirm={onForget}
        onOpenChange={onConfirmForgetChange}
      />
      <FileTreeConfirmDelete
        open={confirmErase}
        name={e.content}
        isDir={false}
        title="Erase this memory and its history?"
        body="It is forgotten, and every earlier wording is overwritten on disk. Use this for a secret that slipped into memory. This can't be undone. Recorded sessions in the Timeline keep their own copy of the conversation; this does not change them."
        confirmLabel="Erase"
        onConfirm={onErase}
        onOpenChange={onConfirmEraseChange}
      />
    </div>
  );
}
