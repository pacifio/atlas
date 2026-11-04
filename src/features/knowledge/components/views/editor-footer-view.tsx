import { ChevronDown, Download, FileText, Globe, Server, type LucideIcon } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Spinner,
} from "@tryatlas/design";

export type ExportKey = "note-md" | "note-html" | "project-md" | "project-html" | "server";

const READ_WPM = 240;

export function readMinutes(words: number): number {
  return Math.max(1, Math.round(words / READ_WPM));
}

interface ExportItemSpec {
  exportKey: ExportKey;
  icon: LucideIcon;
  label: string;
}

const NOTE_ITEMS: readonly ExportItemSpec[] = [
  { exportKey: "note-md", icon: FileText, label: "Export note as .md" },
  { exportKey: "note-html", icon: Globe, label: "Export note as .html" },
];
const PROJECT_ITEMS: readonly ExportItemSpec[] = [
  { exportKey: "project-md", icon: FileText, label: "Export project as .md" },
  { exportKey: "project-html", icon: Globe, label: "Export project as .html" },
];

/**
 * The note's footer: word, character and read-time counts, and the Export
 * menu. While an export runs the trigger shows a spinner and is disabled, so
 * the menu can't be opened twice.
 */
export function EditorFooterView({
  wordCount,
  charCount,
  hasNote,
  busy,
  onExport,
}: {
  wordCount: number;
  charCount: number;
  /** False on a repo README: the two note exports are disabled. */
  hasNote: boolean;
  busy: ExportKey | null;
  onExport: (key: ExportKey) => void;
}) {
  const busyLabel = busy === "server" ? "Building…" : busy ? "Exporting…" : null;

  return (
    <div
      data-view="editor-footer"
      className="flex h-control-sm shrink-0 items-center gap-3.5 border-t border-border-subtle bg-panel px-3.5 text-2xs text-muted-foreground"
    >
      <span>
        <span className="mono tnum">{wordCount.toLocaleString("en-US")}</span> words
      </span>
      <span>
        <span className="mono tnum">{charCount.toLocaleString("en-US")}</span> chars
      </span>
      <span>
        <span className="mono">~{readMinutes(wordCount)}m</span> read
      </span>
      <span className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="xs" disabled={busy !== null} />}
          title={busyLabel ?? "Export"}
        >
          {busyLabel ? (
            <>
              <Spinner size="xs" label="" />
              {busyLabel}
            </>
          ) : (
            <>
              <Icon icon={Download} size="xs" />
              Export
              <Icon icon={ChevronDown} size="xs" className="text-muted-foreground" />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
          {NOTE_ITEMS.map((item) => (
            <ExportItem key={item.exportKey} {...item} disabled={!hasNote} onExport={onExport} />
          ))}
          <DropdownMenuSeparator />
          {PROJECT_ITEMS.map((item) => (
            <ExportItem key={item.exportKey} {...item} onExport={onExport} />
          ))}
          <DropdownMenuSeparator />
          <ExportItem exportKey="server" icon={Server} label="Export server" onExport={onExport} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ExportItem({
  exportKey,
  icon,
  label,
  disabled,
  onExport,
}: ExportItemSpec & { disabled?: boolean; onExport: (key: ExportKey) => void }) {
  return (
    <DropdownMenuItem disabled={disabled} onClick={() => onExport(exportKey)}>
      <Icon icon={icon} size="sm" className="text-muted-foreground" />
      {label}
    </DropdownMenuItem>
  );
}
