import {
  Code,
  Terminal,
  Brain,
  Globe,
  Gauge,
  MessageSquare,
  Network,
  type LucideIcon,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import type { TabType } from "@/lib/constants";
import type { LayoutTemplate } from "../templates";

const TYPE_ICON: Partial<Record<TabType, LucideIcon>> = {
  editor: Code,
  terminal: Terminal,
  knowledge: Brain,
  "knowledge-graph": Network,
  browser: Globe,
  usage: Gauge,
};

function ColIcon({ type }: { type: TabType }) {
  if (type === "chat") return <AtlasIcon size={12} className="rounded-sm opacity-80" />;
  const Icon = TYPE_ICON[type] ?? MessageSquare;
  return <Icon size={12} className="text-[var(--muted-foreground)]" />;
}

/** Schematic mini-window preview of a layout (a block per split column with
 *  its tab-type icon). Pure CSS, monochrome/AMOLED. */
export function LayoutThumbnail({ template }: { template: LayoutTemplate }) {
  return (
    <div className="aspect-[16/10] w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-1 flex gap-1">
      <div className="flex-1 flex gap-0.5 min-w-0">
        {template.columns.map((col, i) => (
          <div
            key={i}
            className="flex-1 min-w-0 rounded-sm bg-[var(--card)] border border-[var(--atlas-border-subtle)] flex items-center justify-center"
          >
            <ColIcon type={col.type} />
          </div>
        ))}
      </div>
    </div>
  );
}
