import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Download,
  FileText,
  Image as ImageIcon,
  FileType2,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import type { TimeRange } from "../../types";

const RANGES: TimeRange[] = ["7d", "30d", "90d", "all"];

export function DashboardHeader({
  range,
  onRange,
  onExport,
  onRefresh,
  loading,
}: {
  range: TimeRange;
  onRange: (r: TimeRange) => void;
  onExport: (kind: "pdf" | "jpeg" | "markdown") => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
      <AtlasIcon size={14} className="rounded-[3px]" />
      <span className="text-[12px] font-semibold text-[var(--text-primary)]">Console</span>
      <div className="flex-1" />

      {/* Time range segmented control */}
      <div className="flex items-center rounded-md border border-[var(--border-default)] overflow-hidden">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRange(r)}
            className={cn(
              "px-2.5 h-[26px] text-[11px] transition-colors",
              r === range
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            {r === "all" ? "All" : r}
          </button>
        ))}
      </div>

      <button
        onClick={onRefresh}
        className={cn(
          "flex items-center justify-center h-[26px] w-[26px] rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors",
          loading && "animate-spin",
        )}
        title="Refresh"
      >
        <RefreshCw size={13} />
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex items-center gap-1.5 h-[26px] px-2.5 rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors outline-none">
            <Download size={12} /> Export{" "}
            <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-[var(--z-max)] min-w-[170px] rounded-lg border border-[var(--border-default)] bg-[#000] py-1.5 shadow-xl text-[12px] text-[var(--text-secondary)]"
          >
            <Item
              icon={<FileType2 size={13} />}
              label="PDF report"
              onSelect={() => onExport("pdf")}
            />
            <Item
              icon={<ImageIcon size={13} />}
              label="JPEG image"
              onSelect={() => onExport("jpeg")}
            />
            <Item
              icon={<FileText size={13} />}
              label="Markdown report"
              onSelect={() => onExport("markdown")}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Item({
  icon,
  label,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex items-center gap-2.5 px-3 h-[28px] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </DropdownMenu.Item>
  );
}
