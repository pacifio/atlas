import { FileX2, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

interface UnsupportedViewProps {
  filePath: string;
}

/**
 * Fallback tab for files Atlas can't open inline. The "Open in Finder" button
 * uses `revealItemInDir` (macOS: opens Finder selecting the file; Linux/Win
 * open the parent folder), which is what users actually want — usually they
 * just need to see the file in its dir so they can copy / move / drag it.
 */
export function UnsupportedView({ filePath }: UnsupportedViewProps) {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "(none)";

  const handleOpenInFinder = async () => {
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      toast.error(`Couldn't reveal in Finder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-[var(--bg-base)]">
      <div className="flex items-center px-3 h-[32px] border-b border-[var(--border-default)] shrink-0 text-[11px] font-mono text-[var(--text-tertiary)] truncate">
        {filePath}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-md">
          <div className="size-12 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center">
            <FileX2 className="size-5 text-[var(--text-tertiary)]" />
          </div>
          <div className="space-y-1">
            <div className="text-sm text-[var(--text-primary)] font-mono">{name}</div>
            <div className="text-[11px] text-[var(--text-tertiary)]">
              File type <span className="font-mono text-[var(--text-secondary)]">.{ext}</span> not
              supported for inline preview.
            </div>
          </div>
          <button
            onClick={handleOpenInFinder}
            className="flex items-center gap-1.5 px-3 h-7 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            <FolderOpen size={12} />
            Open in Finder
          </button>
        </div>
      </div>
    </div>
  );
}
