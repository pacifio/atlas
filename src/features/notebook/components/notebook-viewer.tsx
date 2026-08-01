import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import {
  joinSource,
  notebookLanguage,
  stripAnsi,
  type NotebookCell,
  type NotebookFile,
  type NotebookOutput,
} from "../lib/notebook-types";

interface NotebookViewerProps {
  filePath: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; notebook: NotebookFile };

/**
 * `.ipynb` tab handler. Read-only render of nbformat v4: markdown cells go
 * through the shared `Markdown` renderer, code cells are rendered as a fenced
 * block (same renderer, borrows its highlight.js styling) with an execution
 * count gutter, and outputs are rendered per MIME type. Not a Jupyter
 * client — nothing here executes; it's a viewer for the notebook as saved.
 */
export function NotebookViewer({ filePath }: NotebookViewerProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    invoke<string>("read_file_content", { path: filePath })
      .then((text) => {
        if (cancelled) return;
        try {
          const notebook = JSON.parse(text) as NotebookFile;
          if (!Array.isArray(notebook.cells)) {
            throw new Error('missing a top-level "cells" array');
          }
          setState({ status: "ready", notebook });
        } catch (err) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="h-full w-full flex flex-col bg-[var(--bg-base)]">
      <div className="flex items-center px-3 h-[32px] border-b border-[var(--border-default)] shrink-0 text-[11px] font-mono text-[var(--text-tertiary)] truncate">
        {filePath}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="h-full flex items-center justify-center text-[var(--text-tertiary)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : state.status === "error" ? (
          <div className="p-6 text-[12px] text-[var(--danger,#e5484d)]">
            Couldn't parse this notebook: {state.message}
          </div>
        ) : (
          <NotebookBody notebook={state.notebook} />
        )}
      </div>
    </div>
  );
}

function NotebookBody({ notebook }: { notebook: NotebookFile }) {
  const language = useMemo(() => notebookLanguage(notebook), [notebook]);

  if (notebook.cells.length === 0) {
    return (
      <div className="text-[12px] text-[var(--text-tertiary)] text-center py-12">
        Empty notebook
      </div>
    );
  }

  return (
    <div className="max-w-[900px] mx-auto px-4 py-4 space-y-3">
      {notebook.cells.map((cell, i) => (
        <NotebookCellView key={i} cell={cell} language={language} />
      ))}
    </div>
  );
}

function NotebookCellView({
  cell,
  language,
}: {
  cell: NotebookCell;
  language: string;
}) {
  const source = joinSource(cell.source);

  if (cell.cell_type === "markdown") {
    return source.trim() ? (
      <div className="px-1">
        <Markdown>{source}</Markdown>
      </div>
    ) : null;
  }

  if (cell.cell_type === "raw") {
    return (
      <pre className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-[12px] font-mono whitespace-pre-wrap overflow-x-auto text-[var(--text-secondary)]">
        {source}
      </pre>
    );
  }

  // code cell
  const count = cell.execution_count;
  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 pt-1.5 text-right text-[11px] font-mono text-[var(--text-tertiary)] select-none">
        {count != null ? (
          `[${count}]`
        ) : (
          <Play size={10} className="inline opacity-40" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        {source.trim() && (
          <Markdown>{"```" + language + "\n" + source + "\n```"}</Markdown>
        )}
        {cell.outputs?.map((out, i) => (
          <NotebookOutputView key={i} output={out} />
        ))}
      </div>
    </div>
  );
}

function NotebookOutputView({ output }: { output: NotebookOutput }) {
  if (output.output_type === "stream") {
    return (
      <pre
        className={cn(
          "rounded-md border p-2.5 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto",
          output.name === "stderr"
            ? "border-[var(--danger,#e5484d)]/30 bg-[rgba(229,72,77,0.06)] text-[var(--danger,#e5484d)]"
            : "border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]",
        )}
      >
        {joinSource(output.text)}
      </pre>
    );
  }

  if (output.output_type === "error") {
    const trace = (output.traceback ?? []).map(stripAnsi).join("\n");
    return (
      <pre className="rounded-md border border-[var(--danger,#e5484d)]/30 bg-[rgba(229,72,77,0.06)] p-2.5 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-[var(--danger,#e5484d)]">
        {trace || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }

  // execute_result / display_data — pick the richest MIME type we can safely
  // render. Raw text/html is intentionally NOT rendered: nbformat outputs are
  // static data embedded in the file (not re-executed on open), so dumping
  // them into the DOM via dangerouslySetInnerHTML without a sanitizer would
  // let a malicious notebook run script/event-handler payloads just by being
  // viewed.
  const data = output.data ?? {};
  const imageMime = Object.keys(data).find((m) => m.startsWith("image/"));
  if (imageMime) {
    const raw = joinSource(data[imageMime]).replace(/\n/g, "");
    return (
      <img
        src={`data:${imageMime};base64,${raw}`}
        alt="Cell output"
        className="max-w-full rounded-md border border-[var(--border-default)]"
      />
    );
  }
  if (data["text/plain"]) {
    return (
      <pre className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-[var(--text-secondary)]">
        {joinSource(data["text/plain"])}
      </pre>
    );
  }
  const anyMime = Object.keys(data)[0];
  if (anyMime) {
    return (
      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5 text-[11px] text-[var(--text-tertiary)]">
        Output type <span className="font-mono">{anyMime}</span> isn't rendered
        in Atlas yet.
      </div>
    );
  }
  return null;
}
