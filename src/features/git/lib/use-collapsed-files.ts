import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

/**
 * The set of collapsed files in a multi-file diff. With `diffFilesCollapsed`
 * on, each file starts collapsed the first time it appears — including files
 * that arrive later, as the diff loads or refreshes — while a file the user
 * opened stays open. A diff of one file is never collapsed for them.
 */
export function useCollapsedFiles(paths: readonly string[]) {
  const collapseNew = useSettingsStore((s) => s.settings.diffFilesCollapsed);
  const key = useMemo(() => paths.join("\0"), [paths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(collapseNew && paths.length > 1 ? paths : []),
  );
  const seen = useRef(new Set(paths));
  useEffect(() => {
    const fresh = paths.filter((path) => !seen.current.has(path));
    for (const path of fresh) seen.current.add(path);
    if (collapseNew && paths.length > 1 && fresh.length > 0) {
      setCollapsed((current) => new Set([...current, ...fresh]));
    }
    // `key` stands for `paths`, which is a fresh array on every parse.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, collapseNew]);
  return [collapsed, setCollapsed] as const;
}
