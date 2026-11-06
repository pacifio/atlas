import { useMemo } from "react";
import { FileWarning, NotebookText, Play } from "lucide-react";
import { EmptyState, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { ViewerHeaderView } from "@/components/viewer-header-view";
import {
  codeFence,
  imageOutputSrc,
  joinSource,
  notebookLanguage,
  pickOutputMime,
  stripAnsi,
  type NotebookCell,
  type NotebookFile,
  type NotebookOutput,
} from "../../lib/notebook-types";

export type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; notebook: NotebookFile };

export interface NotebookViewerViewProps {
  filePath: string;
  state: LoadState;
  /** Where a markdown cell's file paths resolve (`documentFileRoot`). */
  fileRoot: string | null;
}

/**
 * Read-only render of an nbformat v4 notebook: markdown cells go through the
 * shared `Markdown` renderer, code cells are rendered as a fenced block (same
 * renderer, borrows its highlight.js styling) with an execution count gutter,
 * and outputs are rendered per MIME type.
 */
export function NotebookViewerView({ filePath, state, fileRoot }: NotebookViewerViewProps) {
  return (
    <div data-view="notebook-viewer" className="flex h-full w-full flex-col bg-background">
      <ViewerHeaderView path={filePath} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size="md" />
          </div>
        ) : state.status === "error" ? (
          <EmptyState
            icon={FileWarning}
            title="Couldn't open this notebook"
            description={state.message}
          />
        ) : (
          <NotebookBody notebook={state.notebook} fileRoot={fileRoot} />
        )}
      </div>
    </div>
  );
}

function NotebookBody({ notebook, fileRoot }: { notebook: NotebookFile; fileRoot: string | null }) {
  const language = useMemo(() => notebookLanguage(notebook), [notebook]);

  if (notebook.cells.length === 0) {
    return <EmptyState icon={NotebookText} title="Empty notebook" />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3 px-4 py-4">
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
      <pre className="code overflow-x-auto rounded-md border border-border bg-card p-3 whitespace-pre-wrap text-secondary-foreground">
        {source}
      </pre>
    );
  }

  // code cell
  const count = cell.execution_count;
  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 pt-1.5 text-right font-mono text-xs text-muted-foreground tabular-nums select-none">
        {count != null ? `[${count}]` : <Play size={10} className="inline opacity-40" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {source.trim() && <Markdown>{codeFence(source, language)}</Markdown>}
        {cell.outputs?.map((out, i) => (
          <NotebookOutputView key={i} output={out} />
        ))}
      </div>
    </div>
  );
}

const OUTPUT_PRE = "rounded-md border p-2.5 text-xs font-mono whitespace-pre-wrap overflow-x-auto";
const OUTPUT_PLAIN = "border-border bg-card text-secondary-foreground";
const OUTPUT_ERROR = "border-error/30 bg-error-muted text-error";

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
        className="max-w-full rounded-md border border-border"
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
      <div className="rounded-md border border-border bg-card p-2.5 text-xs text-muted-foreground">
        Output type <span className="font-mono">{anyMime}</span> isn't rendered in Atlas yet.
      </div>
    );
  }
  return null;
}
