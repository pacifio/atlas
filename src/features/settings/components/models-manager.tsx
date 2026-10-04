import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, Download, Check, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { useAppStore } from "@/features/app/stores/app-store";
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
  const projectPath = useAppStore.use.currentProject()?.path ?? null;

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

  // Selecting a memory model rebuilds the per-project memory index (a
  // different vector space), so it is confirmed first. A code model only
  // swaps the code index's embedder, which re-syncs in the background.
  const doUse = (m: ModelStatus) => {
    if (m.selected) return;
    if (m.kind === "code_embedding") {
      void actions
        .select(m.id)
        .then(() => toast.success(`Using ${m.name} for code search`))
        .catch((e) => toast.error(`${e instanceof Error ? e.message : String(e)}`));
      return;
    }
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
      <div className="shrink-0 border-b border-border px-4 py-2.5 flex items-center gap-2">
        <div className="relative w-[240px]">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
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
              "w-full h-7 pl-8 pr-2.5 rounded-md bg-card border border-border",
              "text-xs text-foreground placeholder:text-muted-foreground",
              "focus:outline-none focus:border-border-strong",
            )}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!loaded ? (
          <div className="p-8 text-center text-xs text-muted-foreground">Loading models…</div>
        ) : (
          <div className="min-w-[560px]">
            {/* header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 h-8 bg-background border-b border-border text-2xs uppercase tracking-wider text-muted-foreground">
              <div className={COL.name}>Model</div>
              <div className={COL.size}>Size</div>
              <div className={COL.dim}>Dim</div>
              <div className={COL.status}>Status</div>
              <div className={COL.use}>Use</div>
            </div>
            {rows.map((m) => {
              const dl = downloading[m.id];
              const busy = pending === m.id;
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle hover:bg-element-hover"
                >
                  <div className={COL.name}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground">{m.name}</span>
                      {m.selected && (
                        <span className="text-3xs uppercase tracking-wide text-[var(--background)] bg-primary rounded px-1 py-px">
                          In use
                        </span>
                      )}
                      {m.kind === "code_embedding" && (
                        <span className="text-3xs uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-px">
                          Code search
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-muted-foreground mt-0.5 truncate">
                      {m.description}
                    </div>
                  </div>
                  <div className={cn(COL.size, "text-xs text-secondary-foreground")}>
                    {fmtSize(m.sizeMb)}
                  </div>
                  <div className={cn(COL.dim, "text-xs text-secondary-foreground")}>
                    {m.dim ?? "—"}
                  </div>
                  <div className={COL.status}>
                    {dl ? (
                      <ProgressBar dl={dl} />
                    ) : m.downloaded ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-secondary-foreground">
                        <Check size={12} className="text-secondary-foreground" /> Downloaded
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void doDownload(m)}
                        className="inline-flex items-center gap-1 h-6 rounded-md px-2 text-2xs font-medium border border-border bg-card text-foreground hover:bg-element-hover transition-colors"
                      >
                        <Download size={11} /> Download
                      </button>
                    )}
                  </div>
                  <div className={cn(COL.use, "flex items-center justify-end gap-1")}>
                    {m.selected ? (
                      <span className="inline-flex items-center gap-1 h-6 px-2 text-2xs font-medium text-secondary-foreground">
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
                            ? `Use ${m.name} for ${m.kind === "code_embedding" ? "code search" : "embeddings"}`
                            : "Download this model first"
                        }
                        aria-label={
                          m.downloaded
                            ? `Use ${m.name} for ${m.kind === "code_embedding" ? "code search" : "embeddings"}`
                            : "Download this model first"
                        }
                        onClick={() => void doUse(m)}
                        className="h-6 rounded-md px-2 text-2xs font-medium border border-border bg-card text-foreground hover:bg-element-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : "Use"}
                      </button>
                    )}
                    {m.downloaded && !m.selected && (
                      <Hint label="Remove download">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void doRemove(m)}
                          className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-[var(--atlas-status-error-foreground)] hover:bg-element-hover transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                        </button>
                      </Hint>
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
      <div className="h-1.5 w-[120px] rounded-full bg-card overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-2xs tabular-nums text-muted-foreground">{pct}%</span>
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
      className="fixed inset-0 z-modal flex items-center justify-center scrim"
      onClick={onCancel}
    >
      <div
        className="w-[380px] rounded-lg border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            size={16}
            className="text-[var(--atlas-status-warning-foreground)] shrink-0 mt-0.5"
          />
          <div>
            <p className="text-base font-semibold text-foreground">Switch embedding model?</p>
            <p className="text-xs text-secondary-foreground mt-1 leading-relaxed">
              Using <span className="text-foreground">{name}</span> re-embeds your memory in a new
              vector space. Atlas will wipe this project's memory index and rebuild it in the
              background. Your notes and files are untouched.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-md px-3 text-xs font-medium border border-border bg-card text-secondary-foreground hover:bg-element-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-7 rounded-md px-3 text-xs font-medium bg-primary text-[var(--background)] hover:opacity-90 transition-opacity"
          >
            Switch & rebuild
          </button>
        </div>
      </div>
    </div>
  );
}
