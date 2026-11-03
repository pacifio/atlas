// Containers for the Shared view's Memories table: expand/select/export state,
// the "Memory updated" focus hand-off, and each entry's edit/forget/erase.
// The markup lives in `./views/shared-memory-entries-view.tsx`.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { sharedMemory } from "../lib/shared-memory-api";
import type { MemoryEntry, Provenance } from "../lib/shared-memory-api";
import { exportable } from "../lib/shared-memory-format";
import { ExportAgentsModal } from "./shared-memory-modals";
import { EntryDetailView, MemoriesTableView } from "./views/shared-memory-entries-view";

export function MemoriesTable({ rows }: { rows: MemoryEntry[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const focusEntryId = useMemoryStore.use.focusEntryId();
  const { clearFocusEntry } = useMemoryStore.use.actions();
  // Expand the entry asked for once its row is listed, then consume the ask.
  useEffect(() => {
    if (focusEntryId == null || !rows.some((r) => r.id === focusEntryId)) return;
    setExpanded(focusEntryId);
    clearFocusEntry();
    scroller.current
      ?.querySelector(`[data-entry-id="${focusEntryId}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focusEntryId, rows, clearFocusEntry]);
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // In the order picked; a row filtered out of view, or no longer
  // exportable, is not exported.
  const chosen = [...selected].filter((id) => rows.some((r) => r.id === id && exportable(r)));
  return (
    <MemoriesTableView
      scrollerRef={scroller}
      rows={rows}
      chosenCount={chosen.length}
      onExport={() => setExporting(true)}
      exportModal={
        <ExportAgentsModal
          open={exporting}
          ids={chosen}
          onOpenChange={setExporting}
          onWritten={() => setSelected(new Set())}
        />
      }
      expandedId={expanded}
      onToggleRow={(id) => setExpanded((c) => (c === id ? null : id))}
      selected={selected}
      onSelectRow={toggle}
      renderDetail={(e) => <EntryDetail entry={e} />}
    />
  );
}

/** An expanded entry: its full provenance, its content, and the edit and
 *  forget actions. Editing follows the Policy view: a draft, save, revert. */
function EntryDetail({ entry: e }: { entry: MemoryEntry }) {
  const { editEntry, forgetEntry, purgeEntry } = useSharedMemoryStore.use.actions();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(e.content);
  const [saving, setSaving] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [provenance, setProvenance] = useState<Provenance[]>([]);

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    sharedMemory
      .provenance(projectPath, e.id)
      .then((p) => {
        if (alive) setProvenance(p ?? []);
      })
      .catch(() => {
        if (alive) setProvenance([]);
      });
    return () => {
      alive = false;
    };
  }, [projectPath, e.id]);
  const dirty = draft.trim() !== e.content.trim() && draft.trim().length > 0;

  useEffect(() => {
    if (!editing) setDraft(e.content);
  }, [e.content, editing]);

  const cancel = () => {
    setDraft(e.content);
    setEditing(false);
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await editEntry(e.id, draft);
      setEditing(false);
      toast.success("Memory updated");
    } catch (err) {
      toast.error(`Couldn't update: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const forget = async () => {
    setConfirmForget(false);
    try {
      await forgetEntry(e.id);
      toast.success("Memory forgotten");
    } catch (err) {
      toast.error(`Couldn't forget: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const erase = async () => {
    setConfirmErase(false);
    try {
      await purgeEntry(e.id);
      toast.success("Memory erased with its history");
    } catch (err) {
      toast.error(`Couldn't erase: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <EntryDetailView
      entry={e}
      editing={editing}
      draft={draft}
      dirty={dirty}
      saving={saving}
      provenance={provenance}
      confirmForget={confirmForget}
      confirmErase={confirmErase}
      onDraftChange={setDraft}
      onEdit={() => setEditing(true)}
      onSave={() => void save()}
      onCancel={cancel}
      onAskForget={() => setConfirmForget(true)}
      onAskErase={() => setConfirmErase(true)}
      onForget={() => void forget()}
      onErase={() => void erase()}
      onConfirmForgetChange={setConfirmForget}
      onConfirmEraseChange={setConfirmErase}
    />
  );
}
