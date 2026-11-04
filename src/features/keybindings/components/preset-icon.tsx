import { CodeXml } from "lucide-react";
import { CursorMark, JetBrainsMark, ZedMark } from "@tryatlas/design";
import type { PresetId } from "../lib/presets";

/** The editor's mark for a preset. Decorative: the label beside it already
 *  names the editor. VS Code gets a plain code glyph — it has no mark we can
 *  use (Simple Icons dropped every Microsoft mark). */
export function PresetIcon({ id, className }: { id: PresetId; className?: string }) {
  switch (id) {
    case "vscode":
      return <CodeXml aria-hidden strokeWidth={2} className={className} />;
    case "cursor":
      return <CursorMark aria-hidden className={className} />;
    case "zed":
      return <ZedMark aria-hidden title="" className={className} />;
    case "jetbrains":
      return <JetBrainsMark aria-hidden title="" className={className} />;
  }
}
