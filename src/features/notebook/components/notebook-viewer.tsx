import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/features/app/stores/app-store";
import { documentFileRoot } from "@/lib/file-links";
import { Markdown } from "@/lib/markdown";
import {
  codeFence,
  imageOutputSrc,
  joinSource,
  notebookLanguage,
  parseNotebook,
  pickOutputMime,
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
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const fileRoot = documentFileRoot(filePath, projectPath);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    invoke<string>("read_file_content", { path: filePath })
      .then((text) => {
        if (!cancelled) setState({ status: "ready", notebook: parseNotebook(text) });
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
    <div className="h-full w-full flex flex-col bg-[var(--background)]">
      <div className="flex items-center px-3 h-[32px] border-b border-[var(--border)] shrink-0 text-xs font-mono text-[var(--muted-foreground)] truncate">
        {filePath}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="h-full flex items-center justify-center text-[var(--muted-foreground)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : state.status === "error" ? (
          <div className="p-6 text-sm text-destructive">
            Couldn't open this notebook: {state.message}
          </div>
        ) : (
          <NotebookBody notebook={state.notebook} fileRoot={fileRoot} />
        )}
      </div>
    </div>
  );
}

function NotebookBody({
  notebook,
  fileRoot,
}: {
  notebook: NotebookFile;
  /** Where a markdown cell's file paths resolve (`documentFileRoot`). */
  fileRoot: string | null;
}) {
  const language = useMemo(() => notebookLanguage(notebook), [notebook]);

  if (notebook.cells.length === 0) {
    return (
      <div className="text-sm text-[var(--muted-foreground)] text-center py-12">Empty notebook</div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-4 space-y-3">
      {notebook.cells.map((cell, i) => (
        <NotebookCellView key={i} cell={cell} language={language} fileRoot={fileRoot} />
      ))}
    </div>
  );
}

function NotebookCellView({
  cell,
  language,
  fileRoot,
}: {
  cell: NotebookCell;
  language: string;
  fileRoot: string | null;
}) {
  const source = joinSource(cell.source);

  if (cell.cell_type === "markdown") {
    return source.trim() ? (
      <div className="px-1">
        <Markdown fileRoot={fileRoot}>{source}</Markdown>
      </div>
    ) : null;
  }

  if (cell.cell_type === "raw") {
    return (
      <pre className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 code whitespace-pre-wrap overflow-x-auto text-[var(--secondary-foreground)]">
        {source}
      </pre>
    );
  }

  // code cell
  const count = cell.execution_count;
  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 pt-1.5 text-right text-xs font-mono text-[var(--muted-foreground)] select-none">
        {count != null ? `[${count}]` : <Play size={10} className="inline opacity-40" />}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        {source.trim() && <Markdown>{codeFence(source, language)}</Markdown>}
        {cell.outputs?.map((out, i) => (
          <NotebookOutputView key={i} output={out} />
        ))}
      </div>
    </div>
  );
}

const OUTPUT_PRE = "rounded-md border p-2.5 text-xs font-mono whitespace-pre-wrap overflow-x-auto";
const OUTPUT_PLAIN = "border-[var(--border)] bg-[var(--card)] text-[var(--secondary-foreground)]";
const OUTPUT_ERROR = "border-destructive/30 bg-destructive/5 text-destructive";

function NotebookOutputView({ output }: { output: NotebookOutput }) {
  if (output.output_type === "stream") {
    return (
      <pre className={cn(OUTPUT_PRE, output.name === "stderr" ? OUTPUT_ERROR : OUTPUT_PLAIN)}>
        {stripAnsi(joinSource(output.text))}
      </pre>
    );
  }

  if (output.output_type === "error") {
    const trace = (output.traceback ?? []).map(stripAnsi).join("\n");
    return (
      <pre className={cn(OUTPUT_PRE, OUTPUT_ERROR)}>
        {trace || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }

  // execute_result / display_data. `pickOutputMime` never returns text/html
  // or anything script-bearing: these outputs are static data from the file,
  // and injecting them into the DOM would let a malicious notebook run code
  // just by being viewed.
  const data = output.data ?? {};
  const mime = pickOutputMime(data);
  if (mime?.startsWith("image/")) {
    return (
      <img
        src={imageOutputSrc(mime, data[mime])}
        alt="Cell output"
        className="max-w-full rounded-md border border-[var(--border)]"
      />
    );
  }
  if (mime === "text/markdown") {
    return <Markdown>{joinSource(data[mime])}</Markdown>;
  }
  if (mime === "text/plain") {
    return <pre className={cn(OUTPUT_PRE, OUTPUT_PLAIN)}>{stripAnsi(joinSource(data[mime]))}</pre>;
  }
  const anyMime = Object.keys(data)[0];
  if (anyMime) {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-2.5 text-xs text-[var(--muted-foreground)]">
        Output type <span className="font-mono">{anyMime}</span> isn't rendered in Atlas yet.
      </div>
    );
  }
  return null;
}
