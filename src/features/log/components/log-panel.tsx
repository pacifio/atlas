import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useAppStore } from "@/features/app/stores/app-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useLogStore, type LogEntry } from "../stores/log-store";
import {
  defaultLogFilters,
  filterLogEntries,
  formatLogLine,
  mergeLogEntries,
  type LogFilters,
} from "../lib/log-view-model";
import { LogPanelView, type LogCopyFormat } from "./views/log-panel-view";

/** The Log tab: the activity buffer and the pins, filtered. */
export function LogPanel() {
  const buffer = useLogStore.use.buffer();
  const pinned = useLogStore.use.pinned();
  const ready = useLogStore.use.ready();
  const { loadPinned, loadProject, pin, unpin, clearBuffer, clearPinned } =
    useLogStore.use.actions();

  const currentProject = useAppStore.use.currentProject();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();

  const [filters, setFilters] = useState<LogFilters>(defaultLogFilters);

  // Keyed on the Organisation, not just on `ready`: the panel can mount before
  // the org store has hydrated (pins then load as empty), and an org switch has
  // to re-read. `loadPinned` no-ops when the loaded org already matches, so
  // firing it on every org change is free.
  useEffect(() => {
    void loadPinned();
  }, [activeOrganisationId, ready, loadPinned]);

  // Restore (and scope) the activity log for the current project from disk.
  useEffect(() => {
    if (currentProject?.path) void loadProject(currentProject.path);
  }, [currentProject?.path, loadProject]);

  // Buffer + pinned (newest first, dedupe by id).
  const merged = useMemo(() => mergeLogEntries(buffer, pinned), [buffer, pinned]);
  const projectPath = currentProject?.path ?? null;
  const entries = useMemo(
    () => filterLogEntries(merged, filters, projectPath),
    [merged, filters, projectPath],
  );

  const onTogglePin = (e: LogEntry) => {
    if (e.pinned) unpin(e.id);
    else pin(e.id);
  };

  const onCopy = async (e: LogEntry, format: LogCopyFormat) => {
    const ok = await copyText(format === "json" ? JSON.stringify(e, null, 2) : formatLogLine(e));
    if (ok && format === "line") toast.success("Copied");
    return ok;
  };

  const onClear = () => {
    if (filters.pinnedOnly) clearPinned();
    else clearBuffer();
  };

  return (
    <LogPanelView
      entries={entries}
      totalCount={merged.length}
      filters={filters}
      onFiltersChange={setFilters}
      hasProject={!!currentProject}
      onTogglePin={onTogglePin}
      onCopy={onCopy}
      onClear={onClear}
    />
  );
}
