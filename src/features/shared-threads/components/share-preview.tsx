import { FileImage, FileMinus, FileText, ShieldAlert } from "lucide-react";

import { Badge } from "@/ui/badge";
import { cn } from "@/lib/utils";

import type { ShareFile } from "../lib/shared-threads-api";

/** `1.2 KB`, `3.4 MB` — sizes as the dialog shows them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What one secret reason means, in words. */
function reasonText(reason: string): string {
  return reason === "name" ? "Its name says it holds credentials" : `Looks like it holds: ${reason}`;
}

/** The files that will go, given the blocked ones included anyway. */
export function uploads(files: ShareFile[], include: string[]): ShareFile[] {
  return files.filter((f) => f.blocked === null || include.includes(f.path));
}

/**
 * Exactly what a share uploads (ATL-402): every changed file, with the
 * secret-shaped ones blocked unless the person ticks "Include anyway" for
 * that file. The repository itself never goes, and nothing is redacted — a
 * file goes whole, or stays here.
 */
export function SharePreviewList({
  files,
  include,
  onToggle,
  serveHistory = false,
}: {
  files: ShareFile[];
  include: string[];
  onToggle: (path: string, included: boolean) => void;
  /** Whether the person also agreed to send the repository's history. */
  serveHistory?: boolean;
}) {
  const going = uploads(files, include);
  return (
    <div className="flex flex-col gap-2">
      <p className="leading-relaxed text-[var(--muted-foreground)]">
        {going.length === 0
          ? "No changed files will be uploaded — the thread starts at your checked-out commit."
          : `${going.length} changed ${going.length === 1 ? "file" : "files"} will be uploaded.`}{" "}
        <span className="text-[var(--secondary-foreground)]">
          {serveHistory
            ? "Your repository is uploaded only as history, to a teammate who joins without your commit"
            : "Your repository is not uploaded"}
        </span>
        , and ignored files (<span className="font-mono">.gitignore</span>,{" "}
        <span className="font-mono">.atlas/shareignore</span>) never are.
      </p>
      {files.length > 0 && (
        <ul
          aria-label="Files to share"
          className="flex max-h-56 flex-col overflow-y-auto rounded border border-[var(--atlas-border-subtle)]"
        >
          {files.map((file) => (
            <ShareRow
              key={file.path}
              file={file}
              included={include.includes(file.path)}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ShareRow({
  file,
  included,
  onToggle,
}: {
  file: ShareFile;
  included: boolean;
  onToggle: (path: string, included: boolean) => void;
}) {
  const Icon = file.deleted ? FileMinus : file.kind === "binary" ? FileImage : FileText;
  const blocked = file.blocked !== null;
  return (
    <li
      data-blocked={blocked || undefined}
      className={cn(
        "flex flex-col gap-1 border-b border-[var(--atlas-border-subtle)] px-2 py-1.5 last:border-b-0",
        blocked && !included && "bg-warning-muted",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={11} className="shrink-0 text-[var(--muted-foreground)]" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            blocked && !included ? "text-warning" : "text-[var(--foreground)]",
            file.deleted && "line-through",
          )}
          title={file.path}
        >
          {file.path}
        </span>
        {file.deleted ? (
          <Badge variant="outline">Deleted</Badge>
        ) : (
          <span className="shrink-0 tabular-nums text-[var(--muted-foreground)]">
            {formatBytes(file.bytes)}
          </span>
        )}
        {file.kind === "binary" && !file.deleted && <Badge variant="secondary">Binary</Badge>}
      </div>
      {blocked && (
        <div className="flex items-start gap-1.5 pl-[17px]">
          <ShieldAlert size={11} className="mt-px shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-[var(--secondary-foreground)]">
            {reasonText(file.blocked!)} — kept on this machine.
          </span>
          <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[var(--secondary-foreground)]">
            <input
              type="checkbox"
              checked={included}
              onChange={(e) => onToggle(file.path, e.target.checked)}
              className="size-3 cursor-pointer accent-[var(--primary)]"
            />
            Include anyway
          </label>
        </div>
      )}
    </li>
  );
}
