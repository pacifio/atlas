import { MessageSquare } from "lucide-react";
import { AtlasIcon } from "@/components/brand-marks";
import type { TabType } from "@/lib/constants";
import type { LayoutTemplate } from "../templates";
import { tabIcons } from "./pane-tab";

/** A column's glyph: the same icon its tab wears in the strip. */
function ColIcon({ type }: { type: TabType }) {
  if (type === "chat") return <AtlasIcon size={12} className="rounded-sm opacity-80" />;
  const Icon = tabIcons[type] ?? MessageSquare;
  return <Icon size={12} className="text-muted-foreground" />;
}

/** Schematic mini-window preview of a layout (a block per split column with
 *  its tab-type icon). Pure CSS, monochrome/AMOLED. */
export function LayoutThumbnail({ template }: { template: LayoutTemplate }) {
  return (
    <div className="aspect-16/10 w-full rounded-md border border-border bg-background p-1 flex gap-1">
      <div className="flex-1 flex gap-0.5 min-w-0">
        {template.columns.map((col, i) => (
          <div
            key={i}
            className="flex-1 min-w-0 rounded-sm bg-card border border-border-subtle flex items-center justify-center"
          >
            <ColIcon type={col.type} />
          </div>
        ))}
      </div>
    </div>
  );
}
