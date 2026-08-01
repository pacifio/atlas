import { useEffect, useRef, useState, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Image as ImageIcon,
  Film,
  Music,
  FileCode,
  FileX,
  RotateCw,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import {
  fileIndex,
  ensureFileIndex,
  openFileIndex,
  cacheFileList,
  getCachedFileList,
  type FileMatch,
} from "../lib/file-picker-api";
import { openFile } from "@/lib/open-file";
import { classifyFile, type FileKind } from "@/lib/file-types";

const DEBOUNCE_MS = 30;
const RESULT_LIMIT = 200;
const ROW_HEIGHT = 32;

interface FilePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cmd+P file picker. Backed by the Rust FileIndex: empty input returns the
 * first `RESULT_LIMIT` files (most-recent walk order); typing fires a
 * debounced nucleo-matched query and renders top matches. All matching
 * happens in Rust, only the top N entries cross the IPC boundary, so the
 * palette stays snappy on huge repos.
 */
export function FilePicker({ open, onOpenChange }: FilePickerProps) {
  const project = useProjectStore.use.currentProject();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileMatch[]>([]);
  const [selected, setSelected] = useState(0);
  /** True until the Rust FileIndex finishes its initial walk. Drives the
   *  "Indexing files…" hint so users don't see a misleading "No matches"
   *  when they open Cmd+P before the walk completes. */
  const [indexing, setIndexing] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset state every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    // Instant: show the last good walk from cache so the user never sees a
    // blank "Indexing files…" screen while we verify/rebuild the index.
    if (project) {
      const cached = getCachedFileList(project.path);
      if (cached.length) setResults(cached);
    }
    let cancelled = false;
    (async () => {
      // FALLBACK: if the backend has no (or a stale) index — e.g. the initial
      // walk failed or was never triggered — reindex now instead of sitting
      // on "Indexing files…" forever. Coalesced so it runs at most once.
      const status = await ensureFileIndex(project?.path);
      if (cancelled) return;
      setIndexing(status ? !status.indexed : false);
      const r = await fileIndex
        .search("", RESULT_LIMIT)
        .catch(() => [] as FileMatch[]);
      if (cancelled) return;
      setResults(r);
      if (project && r.length) cacheFileList(project.path, r);
    })();
    // Focus after the dialog mounts.
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  // Force a full reindex (the explicit button + recovery path).
  const handleReindex = async () => {
    if (!project || reindexing) return;
    setReindexing(true);
    setIndexing(true);
    await openFileIndex(project.path).catch(() => {});
    const r = await fileIndex
      .search(query, RESULT_LIMIT)
      .catch(() => [] as FileMatch[]);
    setResults(r);
    setSelected(0);
    setIndexing(false);
    setReindexing(false);
    if (project && query.trim() === "" && r.length)
      cacheFileList(project.path, r);
  };

  // Debounced backend search on query change.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      fileIndex
        .search(query, RESULT_LIMIT)
        .then((r) => {
          setResults(r);
          setSelected(0);
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open]);

  // Live re-query when the backend reports an index change. Fired by:
  //   (a) the fs-watch debouncer on add/remove/rename, and
  //   (b) `fileindex_open_project` once the initial walk completes —
  //       this is what flips the palette from "Indexing files…" to real
  //       results when the user opened Cmd+P early.
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<{ count: number }>("atlas:fileindex:updated", () => {
      if (cancelled) return;
      setIndexing(false);
      fileIndex
        .search(query, RESULT_LIMIT)
        .then((r) => {
          setResults(r);
          if (project && query.trim() === "" && r.length)
            cacheFileList(project.path, r);
        })
        .catch(() => {});
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, query, project]);

  // Kbd nav.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, Math.max(0, results.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = results[selected];
        if (pick) {
          openFile(pick.path);
          onOpenChange(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, results, selected, onOpenChange]);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Keep the selected row visible during kbd nav.
  useEffect(() => {
    virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);

  const showEmpty = useMemo(() => results.length === 0, [results.length]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[18%] z-50 -translate-x-1/2",
            "w-[640px] max-w-[92vw] rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-2xl",
            "flex flex-col overflow-hidden",
          )}
        >
          <Dialog.Title className="sr-only">Open file</Dialog.Title>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              project ? "Search files by name or path…" : "Open a project first"
            }
            disabled={!project}
            className="px-4 h-11 bg-transparent border-b border-[var(--border-default)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
          />
          <div
            ref={scrollRef}
            className="max-h-[420px] overflow-y-auto hide-scrollbar"
          >
            {showEmpty ? (
              <div className="px-4 py-3 text-[11px] text-[var(--text-tertiary)]">
                {!project
                  ? "Open a project to enable Cmd+P."
                  : indexing
                    ? "Indexing files… results will appear here."
                    : "No matches."}
              </div>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                }}
              >
                {virtualizer.getVirtualItems().map((v) => {
                  const m = results[v.index];
                  const active = v.index === selected;
                  return (
                    <button
                      key={m.path}
                      data-index={v.index}
                      onMouseEnter={() => setSelected(v.index)}
                      onClick={() => {
                        openFile(m.path);
                        onOpenChange(false);
                      }}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: ROW_HEIGHT,
                        transform: `translateY(${v.start}px)`,
                      }}
                      className={cn(
                        "flex items-center gap-2 px-3 text-left cursor-pointer transition-colors",
                        active
                          ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                      )}
                    >
                      <KindIcon kind={classifyFile(m.path)} />
                      <span className="truncate text-[12px] font-mono">
                        {m.rel}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between px-3 h-7 border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)] font-mono">
            <div className="flex items-center gap-2">
              <button
                onClick={handleReindex}
                disabled={!project || reindexing}
                title="Rebuild the file index"
                className={cn(
                  "flex items-center gap-1 rounded px-1 -ml-1 transition-colors",
                  "hover:text-[var(--text-secondary)] disabled:opacity-40 disabled:cursor-default cursor-pointer outline-none",
                )}
              >
                <RotateCw
                  size={10}
                  className={cn(reindexing && "animate-spin")}
                />
                Reindex
              </button>
              <span>
                {results.length} match{results.length === 1 ? "" : "es"}
              </span>
            </div>
            <span>↑↓ navigate · ↵ open · esc close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function KindIcon({ kind }: { kind: FileKind }) {
  const cls = "size-3 shrink-0 text-[var(--text-tertiary)]";
  if (kind === "image" || kind === "svg") return <ImageIcon className={cls} />;
  if (kind === "video") return <Film className={cls} />;
  if (kind === "audio") return <Music className={cls} />;
  if (kind === "text") return <FileCode className={cls} />;
  return <FileX className={cls} />;
}
