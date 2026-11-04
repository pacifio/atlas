import { RefreshCw, Trash2, Download, FolderInput } from "lucide-react";
import { agentMetaForSource } from "../../lib/memory-agent";
import { KIND_LABEL, entryAgent } from "../../lib/shared-memory-format";
import { FilterMenu, IconButton, SegBtn } from "./shared-memory-primitives";
import { SearchField, Toolbar, Track } from "./memory-chrome";
import { HintGroup } from "@tryatlas/design";

export type SharedMemoryTab = "events" | "plans" | "memories" | "review";

/** The Shared view's toolbar: tab pills, column filters, search and actions. */
export function SharedMemoryToolbar({
  tab,
  onTabChange,
  eventCount,
  planCount,
  entryCount,
  agentFilter,
  agentOptions,
  onAgentFilterChange,
  kindFilter,
  kindOptions,
  onKindFilterChange,
  query,
  onQueryChange,
  onRefresh,
  onImportClaude,
  onImportRepo,
  onClear,
}: {
  tab: SharedMemoryTab;
  onTabChange: (tab: SharedMemoryTab) => void;
  eventCount: number;
  planCount: number;
  entryCount: number;
  agentFilter: string;
  agentOptions: string[];
  onAgentFilterChange: (v: string) => void;
  kindFilter: string;
  kindOptions: string[];
  onKindFilterChange: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  onRefresh: () => void;
  onImportClaude: () => void;
  onImportRepo: () => void;
  onClear: () => void;
}) {
  return (
    <Toolbar>
      {/* Events / Plans / Memories / Review — the Memory nav's track. No
          glyphs: four distinct nouns, and the counts already set them apart. */}
      <Track>
        <SegBtn
          active={tab === "events"}
          onClick={() => onTabChange("events")}
          label="Events"
          count={eventCount}
        />
        <SegBtn
          active={tab === "plans"}
          onClick={() => onTabChange("plans")}
          label="Plans"
          count={planCount}
        />
        <SegBtn
          active={tab === "memories"}
          onClick={() => onTabChange("memories")}
          label="Memories"
          count={entryCount}
        />
        <SegBtn
          active={tab === "review"}
          onClick={() => onTabChange("review")}
          label="Review"
          count={0}
        />
      </Track>

      {/* Column filters */}
      <FilterMenu
        label="Agent"
        value={agentFilter}
        options={agentOptions}
        onChange={onAgentFilterChange}
        format={(a) => (tab === "memories" && !entryAgent(a) ? a : agentMetaForSource(a).label)}
      />
      {tab !== "plans" && (
        <FilterMenu
          label="Kind"
          value={kindFilter}
          options={kindOptions}
          onChange={onKindFilterChange}
          format={(k) => KIND_LABEL[k] ?? k.replace(/_/g, " ")}
        />
      )}

      <div className="flex-1" />

      <SearchField
        value={query}
        onChange={onQueryChange}
        placeholder={`Search ${tab}…`}
        className="w-[200px]"
      />

      <HintGroup>
        <div className="flex items-center gap-1">
          <IconButton label="Refresh" onClick={onRefresh}>
            <RefreshCw size={12} />
          </IconButton>
          <IconButton label="Import Claude memory" onClick={onImportClaude}>
            <Download size={12} />
          </IconButton>
          <IconButton label="Import memory repo" onClick={onImportRepo}>
            <FolderInput size={12} />
          </IconButton>
          <IconButton label="Clear shared memory" onClick={onClear}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      </HintGroup>
    </Toolbar>
  );
}
