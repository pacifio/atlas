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
    <div className="h-full w-full flex flex-col bg-[var(--background)]">
      <div className="flex items-center px-3 h-[32px] border-b border-[var(--border)] shrink-0 text-xs font-mono text-[var(--muted-foreground)] truncate">
        {filePath}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-md">
          <div className="size-12 rounded-full bg-[var(--card)] border border-[var(--border)] flex items-center justify-center">
            <FileX2 className="size-5 text-[var(--muted-foreground)]" />
          </div>
          <div className="space-y-1">
            <div className="text-sm text-[var(--foreground)] font-mono">{name}</div>
            <div className="text-xs text-[var(--muted-foreground)]">
              File type <span className="font-mono text-[var(--secondary-foreground)]">.{ext}</span>{" "}
              not supported for inline preview.
            </div>
          </div>
          <button
            onClick={handleOpenInFinder}
            className="flex items-center gap-1.5 px-3 h-7 rounded border border-[var(--border)] bg-[var(--card)] hover:bg-element-hover text-xs text-[var(--secondary-foreground)] hover:text-[var(--foreground)] cursor-pointer transition-colors"
          >
            <FolderOpen size={12} />
            Open in Finder
          </button>
        </div>
      </div>
    </div>
  );
}
