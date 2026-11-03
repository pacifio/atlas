import {
  RefreshCw,
  Trash2,
  Search,
  ListChecks,
  ScrollText,
  Brain,
  Download,
  Inbox,
  FolderInput,
} from "lucide-react";
import { agentMetaForSource } from "../../lib/memory-agent";
import { HintGroup } from "@/ui/hint-group";
import { KIND_LABEL, entryAgent } from "../../lib/shared-memory-format";
import { FilterMenu, IconButton, SegBtn } from "./shared-memory-primitives";

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
    <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border)]">
      {/* Events / Plans toggle — pill group, matches the Memory nav. */}
      <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card)] p-0.5">
        <SegBtn
          active={tab === "events"}
          onClick={() => onTabChange("events")}
          icon={<ScrollText size={11} />}
          label="Events"
          count={eventCount}
        />
        <SegBtn
          active={tab === "plans"}
          onClick={() => onTabChange("plans")}
          icon={<ListChecks size={11} />}
          label="Plans"
          count={planCount}
        />
        <SegBtn
          active={tab === "memories"}
          onClick={() => onTabChange("memories")}
          icon={<Brain size={11} />}
          label="Memories"
          count={entryCount}
        />
        <SegBtn
          active={tab === "review"}
          onClick={() => onTabChange("review")}
          icon={<Inbox size={11} />}
          label="Review"
          count={0}
        />
      </div>

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

      <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 w-[190px] focus-within:border-[var(--atlas-border-strong)]">
        <Search size={11} className="text-[var(--muted-foreground)] shrink-0" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={`Search ${tab}…`}
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent outline-none text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
        />
      </div>

      <HintGroup>
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
      </HintGroup>
    </div>
  );
}
