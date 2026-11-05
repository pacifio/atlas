import { MessageSquare } from "lucide-react";
import type { TabType } from "@/lib/constants";
import { tabIcons } from "../pane-tab";

/** A tab type with nothing to render yet. Takes the two fields of a layout
 *  `Tab` it reads. */
export function PlaceholderContent({ tab }: { tab: { type: TabType; title: string } }) {
  const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-card border border-border flex items-center justify-center mx-auto">
          <Icon size={24} className="text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{tab.title}</p>
          <p className="text-xs text-muted-foreground mt-1">Coming soon</p>
        </div>
      </div>
    </div>
  );
}
