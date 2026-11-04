import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { isMac, isWindows } from "@/lib/platform";
import { UnsupportedView } from "./views/unsupported-view";

/** What the platform's file manager is called where a reveal opens it. */
const REVEAL = isMac
  ? { label: "Open in Finder", place: "Finder" }
  : isWindows
    ? { label: "Show in Explorer", place: "Explorer" }
    : { label: "Open containing folder", place: "the file manager" };

/**
 * Fallback tab for files Atlas can't open inline. The reveal button uses
 * `revealItemInDir` (macOS: opens Finder selecting the file; Linux/Win open
 * the parent folder), which is what users actually want — usually they just
 * need to see the file in its dir so they can copy / move / drag it.
 */
export function UnsupportedFile({ filePath }: { filePath: string }) {
  const reveal = async () => {
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      toast.error(
        `Couldn't reveal in ${REVEAL.place}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <UnsupportedView
      filePath={filePath}
      revealLabel={REVEAL.label}
      onReveal={() => void reveal()}
    />
  );
}
