import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, Download, Check, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useModelsStore } from "../stores/models-store";
import { models, type ModelStatus } from "../lib/models-api";

const COL = {
  name: "flex-1 min-w-[240px]",
  size: "w-[90px] shrink-0 text-right tabular-nums",
  dim: "w-[70px] shrink-0 text-right tabular-nums",
  status: "w-[220px] shrink-0",
  use: "w-[92px] shrink-0",
};

function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

export function ModelsManager() {
  const loaded = useModelsStore.use.loaded();
  const list = useModelsStore.use.list();
  const downloading = useModelsStore.use.downloading();
  const pending = useModelsStore.use.pending();
  const actions = useModelsStore.use.actions();
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;

  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void actions.init();
  }, [actions]);

  const rows = useMemo(() => {
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [list, query]);

  const doDownload = async (m: ModelStatus) => {
    try {
      await actions.download(m.id);
    } catch (e) {
      toast.error(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doRemove = async (m: ModelStatus) => {
    try {
      await actions.remove(m.id);
      toast.success(`Removed ${m.name}`);
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Selecting a model rebuilds the per-project memory index (a different model
  // means a different vector space), so gate it behind a confirm dialog.
  const doUse = (m: ModelStatus) => {
    if (m.selected) return;
    setConfirm({ id: m.id, name: m.name });
  };

  const confirmSwitch = async () => {
    if (!confirm) return;
    const { id, name } = confirm;
    setConfirm(null);
    try {
      const needsReindex = await actions.select(id);
      toast.success(`Using ${name}`);
      if (needsReindex && projectPath) {
        await models.reindex(projectPath);
        toast("Rebuilding the memory index with the new model…");
      }
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border-default px-4 py-2.5 flex items-center gap-2">
        <div className="relative w-[240px]">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter models…"
            className={cn(
              "w-full h-7 pl-8 pr-2.5 rounded-md bg-bg-elevated border border-border-default",
              "text-[11px] text-text-primary placeholder:text-text-tertiary",
              "focus:outline-none focus:border-border-strong",
            )}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!loaded ? (
          <div className="p-8 text-center text-[11px] text-text-tertiary">Loading models…</div>
        ) : (
          <div className="min-w-[560px]">
            {/* header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 h-8 bg-bg-primary border-b border-border-default text-[10px] uppercase tracking-wider text-text-tertiary">
              <div className={COL.name}>Model</div>
              <div className={COL.size}>Size</div>
              <div className={COL.dim}>Dim</div>
              <div className={COL.status}>Status</div>
              <div className={COL.use}>Use</div>
            </div>
            {rows.length === 0 && query.trim() !== "" && (
              <div className="grid place-items-center gap-2 h-[160px] text-[11px] text-text-tertiary">
                No models match.
                {query.trim() !== "" && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="h-6 rounded-md border border-border-default bg-bg-elevated px-2 text-[10px] text-text-primary hover:bg-bg-hover transition-colors"
                  >
                    Clear filter
                  </button>
                )}
              </div>
            )}
            {rows.map((m) => {
              const dl = downloading[m.id];
              const busy = pending === m.id;
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle hover:bg-bg-hover"
                >
                  <div className={COL.name}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium text-text-primary">{m.name}</span>
                      {m.selected && (
                        <span className="text-[9px] uppercase tracking-wide text-[var(--bg-base)] bg-accent rounded px-1 py-px">
                          In use
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-text-tertiary mt-0.5 truncate">
                      {m.description}
                    </div>
                  </div>
                  <div className={cn(COL.size, "text-[11px] text-text-secondary")}>
                    {fmtSize(m.sizeMb)}
                  </div>
                  <div className={cn(COL.dim, "text-[11px] text-text-secondary")}>
                    {m.dim ?? "—"}
                  </div>
                  <div className={COL.status}>
                    {dl ? (
                      <ProgressBar dl={dl} />
                    ) : m.downloaded ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
                        <Check size={12} className="text-text-secondary" /> Downloaded
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void doDownload(m)}
                        className="inline-flex items-center gap-1 h-6 rounded-md px-2 text-[10px] font-medium border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors"
                      >
                        <Download size={11} /> Download
                      </button>
                    )}
                  </div>
                  <div className={cn(COL.use, "flex items-center justify-end gap-1")}>
                    {m.selected ? (
                      <span className="inline-flex items-center gap-1 h-6 px-2 text-[10px] font-medium text-text-secondary">
                        <Check size={11} /> In use
                      </span>
                    ) : (
                      <button
                        type="button"
                        // Shown even before download so the Download → Use path
                        // is discoverable; a model can only be selected once its
                        // files are on disk.
                        disabled={busy || !m.downloaded}
                        title={
                          m.downloaded
                            ? `Use ${m.name} for embeddings`
                            : "Download this model first"
                        }
                        aria-label={
                          m.downloaded
                            ? `Use ${m.name} for embeddings`
                            : "Download this model first"
                        }
                        onClick={() => void doUse(m)}
                        className="h-6 rounded-md px-2 text-[10px] font-medium border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : "Use"}
                      </button>
                    )}
                    {m.downloaded && !m.selected && (
                      <button
                        type="button"
                        title="Remove download"
                        aria-label="Remove download"
                        disabled={busy}
                        onClick={() => void doRemove(m)}
                        className="h-6 w-6 flex items-center justify-center rounded-md text-text-tertiary hover:text-[var(--status-error)] hover:bg-bg-hover transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirm && (
        <ConfirmReindex
          name={confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmSwitch()}
        />
      )}
    </div>
  );
}

function ProgressBar({
  dl,
}: {
  dl: { fileIndex: number; fileCount: number; received: number; total: number };
}) {
  const pct = Math.min(
    100,
    Math.round(
      ((dl.fileIndex + (dl.total ? dl.received / dl.total : 0)) / Math.max(1, dl.fileCount)) * 100,
    ),
  );
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-[120px] rounded-full bg-bg-elevated overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-text-tertiary">{pct}%</span>
    </div>
  );
}

function ConfirmReindex({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[380px] rounded-lg border border-border-default bg-bg-primary p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="text-[var(--status-warning)] shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] font-semibold text-text-primary">Switch embedding model?</p>
            <p className="text-[11px] text-text-secondary mt-1 leading-relaxed">
              Using <span className="text-text-primary">{name}</span> re-embeds your memory in a new
              vector space. Atlas will wipe this project's memory index and rebuild it in the
              background. Your notes and files are untouched.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-md px-3 text-[11px] font-medium border border-border-default bg-bg-elevated text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-7 rounded-md px-3 text-[11px] font-medium bg-accent text-[var(--bg-base)] hover:opacity-90 transition-opacity"
          >
            Switch & rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
