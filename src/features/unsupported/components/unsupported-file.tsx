import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { UnsupportedView } from "./views/unsupported-view";

/**
 * Fallback tab for files Atlas can't open inline. The "Open in Finder" button
 * uses `revealItemInDir` (macOS: opens Finder selecting the file; Linux/Win
 * open the parent folder), which is what users actually want — usually they
 * just need to see the file in its dir so they can copy / move / drag it.
 */
export function UnsupportedFile({ filePath }: { filePath: string }) {
  const reveal = async () => {
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      toast.error(`Couldn't reveal in Finder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <UnsupportedView
      filePath={filePath}
      revealLabel="Open in Finder"
      onReveal={() => void reveal()}
    />
  );
}
