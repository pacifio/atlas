// Containers for the Shared view's dialogs: state, IPC and toasts. The
// markup lives in `./views/shared-memory-dialogs.tsx`.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { sharedMemory } from "../lib/shared-memory-api";
import type { ClaudeImportPreview, ExportPreview, RepoImportLine } from "../lib/shared-memory-api";
import {
  ExportAgentsDialog,
  ImportClaudeMemoryDialog,
  ImportRepoDialog,
} from "./views/shared-memory-dialogs";

/* ── Import of Claude's auto-memory ──────────────────────────────────────────── */

const NO_PREVIEW: ClaudeImportPreview = { sources: [], alreadyImported: false, lines: [] };

/** The AGENTS.md export: a preview of the file as it would be written, then
 *  Write. Only the managed block changes; nothing is written on Cancel. */
export function ExportAgentsModal({
  open,
  ids,
  onOpenChange,
  onWritten,
}: {
  open: boolean;
  ids: number[];
  onOpenChange: (open: boolean) => void;
  onWritten: () => void;
}) {
  const projectPath = useSharedMemoryStore.use.projectPath();
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const key = ids.join(",");

  useEffect(() => {
    if (!open || !projectPath) return;
    let alive = true;
    setPreview(null);
    setError(null);
    sharedMemory
      .exportPreview(projectPath, ids)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // `key` stands for `ids`: a new array each render must not re-run this.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, key]);

  const write = async () => {
    if (!projectPath) return;
    setWriting(true);
    try {
      const path = await sharedMemory.exportApply(projectPath, ids);
      toast.success(`Wrote ${ids.length} ${ids.length === 1 ? "memory" : "memories"} to ${path}`);
      onWritten();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    } finally {
      setWriting(false);
    }
  };

  return (
    <ExportAgentsDialog
      open={open}
      onOpenChange={onOpenChange}
      preview={preview}
      error={error}
      writing={writing}
      onWrite={() => void write()}
    />
  );
}

/** Import an Agent Memory Repo folder: pick it, see every line it would
 *  write, then Import. Lines land as unconfirmed candidates (Review tab). */
export function ImportRepoModal({
  projectPath,
  open,
  onOpenChange,
  onImported,
}: {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [lines, setLines] = useState<RepoImportLine[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setDir(null);
      setLines(null);
      setSelected(new Set());
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const choose = async () => {
    setError(null);
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ directory: true });
      if (typeof picked !== "string") return;
      // The old folder's lines and picks never pair with a new folder.
      setDir(null);
      setLines(null);
      setSelected(new Set());
      const found = await sharedMemory.previewRepoImport(projectPath, picked);
      setDir(picked);
      setLines(found);
      setSelected(new Set(found.filter((l) => l.isNew).map((l) => l.id)));
    } catch (e) {
      setError(String(e));
    }
  };

  const runImport = async () => {
    if (!dir) return;
    setBusy(true);
    try {
      const count = await sharedMemory.confirmRepoImport(projectPath, dir, [...selected]);
      toast.success(`Imported ${count} ${count === 1 ? "line" : "lines"} to review`);
      onImported();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Import failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ImportRepoDialog
      open={open}
      onOpenChange={onOpenChange}
      dir={dir}
      lines={lines}
      selected={selected}
      error={error}
      busy={busy}
      onChoose={() => void choose()}
      onToggle={toggle}
      onImport={() => void runImport()}
    />
  );
}

/** Preview, then consent: every line Claude's auto-memory maps to, with its
 *  kind; the new ones start ticked. Only Import writes. */
export function ImportClaudeMemoryModal({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const { previewClaudeImport, importClaude } = useSharedMemoryStore.use.actions();
  const [preview, setPreview] = useState<ClaudeImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    void previewClaudeImport()
      .then((found) => {
        if (cancelled) return;
        const p = found ?? NO_PREVIEW;
        setPreview(p);
        setSelected(new Set(p.lines.filter((l) => l.isNew).map((l) => l.id)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(NO_PREVIEW);
        toast.error(`Couldn't read Claude's memory: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, previewClaudeImport]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const runImport = async () => {
    setImporting(true);
    try {
      const count = await importClaude([...selected]);
      toast.success(
        count === 0
          ? "Nothing new to import"
          : `Imported ${count} ${count === 1 ? "memory" : "memories"} from Claude`,
      );
      onOpenChange(false);
      onImported();
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const fresh = preview?.lines.filter((l) => l.isNew).length ?? 0;

  return (
    <ImportClaudeMemoryDialog
      open={open}
      onOpenChange={onOpenChange}
      preview={preview}
      selected={selected}
      importing={importing}
      fresh={fresh}
      onToggle={toggle}
      onImport={() => void runImport()}
    />
  );
}
