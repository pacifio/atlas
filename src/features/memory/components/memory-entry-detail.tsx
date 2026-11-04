// Container for one memory in the Memories pane: its provenance (read from
// the session recorder), the ask to an agent, the in-place edit, verdicts, restore, forget and
// erase. The markup is `./views/memory-entry-detail-view.tsx`.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { sharedMemory, type MemoryEntry, type Provenance } from "../lib/shared-memory-api";
import { provenanceSession } from "../lib/memory-entries";
import { openMemorySession } from "../lib/open-memory-session";
import { entryContext } from "../lib/memory-ask";
import { openAskAgent } from "@/features/ask-agent/lib/ask-agent";
import { MemoryEntryDetailView } from "./views/memory-entry-detail-view";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function MemoryEntryDetail({
  entry: e,
  onClose,
}: {
  entry: MemoryEntry;
  onClose: () => void;
}) {
  const { editEntry, forgetEntry, purgeEntry, feedback, reviewAction } =
    useSharedMemoryStore.use.actions();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(e.content);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [provenance, setProvenance] = useState<Provenance[] | null>(null);

  // Keyed by entry id where it is rendered, so choosing another memory starts
  // clean and leaves any edit of the last one behind.
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

  useEffect(() => {
    if (!editing) setDraft(e.content);
  }, [e.content, editing]);

  const dirty = draft.trim() !== e.content.trim() && draft.trim().length > 0;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await editEntry(e.id, draft);
      setEditing(false);
      toast.success("Memory updated");
    } catch (err) {
      toast.error(`Couldn't update: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  /** Whether the work succeeded; a failure is said in a toast. */
  const run = async (
    work: () => Promise<unknown>,
    done: string,
    failed: string,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
      return true;
    } catch (err) {
      toast.error(`${failed}: ${errorText(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <MemoryEntryDetailView
      entry={e}
      provenance={provenance}
      editing={editing}
      draft={draft}
      dirty={dirty}
      saving={saving}
      busy={busy}
      confirmForget={confirmForget}
      confirmErase={confirmErase}
      onDraftChange={setDraft}
      onEdit={() => setEditing(true)}
      onSave={() => void save()}
      onCancel={() => {
        setDraft(e.content);
        setEditing(false);
      }}
      onAskForget={() => setConfirmForget(true)}
      onAskErase={() => setConfirmErase(true)}
      onForget={() => {
        setConfirmForget(false);
        // The pane closes only once the memory is gone.
        void run(() => forgetEntry(e.id), "Memory forgotten", "Couldn't forget").then(
          (ok) => ok && onClose(),
        );
      }}
      onErase={() => {
        setConfirmErase(false);
        void run(() => purgeEntry(e.id), "Memory erased with its history", "Couldn't erase").then(
          (ok) => ok && onClose(),
        );
      }}
      onConfirmForgetChange={setConfirmForget}
      onConfirmEraseChange={setConfirmErase}
      onMarkOutdated={() =>
        void run(
          () => feedback(e.id, "stale"),
          "Marked as outdated; agents will treat it as unconfirmed",
          "Couldn't mark it",
        )
      }
      onMarkWrong={() =>
        void run(
          () => feedback(e.id, "wrong"),
          "Marked as wrong and archived; its history stays",
          "Couldn't mark it",
        )
      }
      onRestore={() =>
        void run(
          () => reviewAction((pp) => sharedMemory.promote(pp, e.id)),
          "Memory restored",
          "Couldn't restore",
        )
      }
      onAskAgent={(anchor) =>
        openAskAgent({
          context: [entryContext(e, projectPath)],
          anchor,
          placeholder: "This is outdated, we moved to Postgres…",
        })
      }
      onOpenSession={(p) => {
        const session = provenanceSession(p);
        if (!session || !projectPath) return;
        openMemorySession({
          projectPath,
          sessionId: session.sessionId,
          commitSha: p.commits[0] ?? null,
        });
      }}
      onClose={onClose}
    />
  );
}
