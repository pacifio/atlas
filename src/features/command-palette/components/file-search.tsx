// ⌘P: search the open project's files, in the command shell.
//
// Backed by the Rust FileIndex. Matching is nucleo, in Rust, and only the top
// `FILE_SEARCH_RESULT_LIMIT` rows cross the IPC boundary, so the tree is
// never read on this thread however large the repository. Typing is
// debounced, an older search's late answer is dropped, and the list is
// virtualised. An empty query lists the files open in tabs and the recently
// opened ones first, then the index's walk order, from the last good walk
// (cached per project) until the index answers.

import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Image as ImageIcon, FileCode, FileX, Music } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useRecentFilesStore } from "@/features/chat/stores/recent-files-store";
import {
  cacheFileList,
  ensureFileIndex,
  fileIndex,
  getCachedFileList,
  openFileIndex,
  type FileMatch,
} from "@/features/file-picker/lib/file-picker-api";
import { FileIcon, type FallbackIcon } from "@/features/icon-theme/components/file-icon";
import { openFile } from "@/lib/open-file";
import { classifyFile, type FileKind } from "@/lib/file-types";
import {
  FILE_SEARCH_RESULT_LIMIT,
  emptyQueryFiles,
  highlightSegments,
  toFileSearchMatches,
} from "../lib/file-search-logic";
import type { CommandPaletteActionItem, CommandPaletteEntry } from "../lib/command-palette-logic";
import { CommandPaletteContent } from "./command-palette-content";

/** Long enough to skip the keystrokes of a word, short enough to feel live. */
const DEBOUNCE_MS = 40;

export function FileSearch(props: { onClose: () => void; escapeLabel: string }) {
  const project = useAppStore.use.currentProject();
  const projectPath = project?.path ?? null;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileMatch[]>(() =>
    projectPath ? getCachedFileList(projectPath) : [],
  );
  // The query `results` answers, so highlights match what was searched.
  const [matchedQuery, setMatchedQuery] = useState("");
  const [indexing, setIndexing] = useState(false);
  const searchSeq = useRef(0);

  const openFiles = useLayoutStore((s) => editorPaths(s.tabs));
  const recentFiles = useRecentFilesStore.use.items();

  const runSearch = (q: string) => {
    const seq = ++searchSeq.current;
    return fileIndex
      .search(q, FILE_SEARCH_RESULT_LIMIT)
      .then((found) => {
        if (seq !== searchSeq.current) return;
        setResults(found);
        setMatchedQuery(q);
        if (projectPath && q.trim() === "" && found.length) cacheFileList(projectPath, found);
      })
      .catch(() => {});
  };

  // Make sure the project is indexed (a missing or stale index is rebuilt
  // once, however many callers ask).
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void ensureFileIndex(projectPath).then((status) => {
      if (!cancelled) setIndexing(status ? !status.indexed : false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Debounced search on every query change.
  useEffect(() => {
    if (!projectPath) return;
    const timer = window.setTimeout(() => void runSearch(query), query ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // `runSearch` reads only refs and the project path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, projectPath]);

  // The index changed (a file was added or removed, or the first walk
  // finished): search again.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (!projectPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listen<{ count: number }>("atlas:fileindex:updated", () => {
      if (cancelled) return;
      setIndexing(false);
      void runSearch(queryRef.current);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const reindex = async () => {
    if (!projectPath) return;
    setIndexing(true);
    await openFileIndex(projectPath).catch(() => {});
    await runSearch(queryRef.current);
    setIndexing(false);
  };

  const entries = useMemo(() => {
    if (!projectPath) return [];
    if (matchedQuery.trim() !== "") return results;
    return emptyQueryFiles({ projectPath, openFiles, recentFiles, indexed: results });
  }, [projectPath, matchedQuery, results, openFiles, recentFiles]);

  const items: CommandPaletteActionItem[] = toFileSearchMatches(entries, matchedQuery).map(
    (match) => ({
      kind: "action",
      value: `file:${match.path}`,
      searchTerms: [match.name, match.rel],
      title: <Highlighted value={match.name} indices={match.nameMatchIndices} />,
      description: match.rel,
      icon: <FileIcon path={match.path} size={16} fallback={kindIcon(classifyFile(match.path))} />,
      run: () => void openFile(match.path),
    }),
  );

  const execute = (item: CommandPaletteEntry) => {
    if (item.kind !== "action") return;
    props.onClose();
    void item.run();
  };

  const searching = query.trim() !== "";
  return (
    <CommandPaletteContent
      groups={project && items.length > 0 ? [{ value: "files", label: project.name, items }] : []}
      query={query}
      onQueryChange={setQuery}
      onExecute={execute}
      placeholder="Search files…"
      disabled={!project}
      emptyMessage={
        !project
          ? "Open a project to search its files."
          : indexing
            ? searching
              ? "Searching workspace files…"
              : "Indexing workspace files…"
            : searching
              ? "No matching files."
              : "No files found."
      }
      footerActionLabel="Open file"
      escapeLabel={props.escapeLabel}
      footerTrailing={
        project ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void reindex()}
            disabled={indexing}
            title="Rebuild the file index"
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reindex
          </button>
        ) : undefined
      }
      size="tall"
      testId="file-search"
    />
  );
}

/** The file tabs' paths. Cached per `tabs` array, so the selector returns the
 *  same array until the tabs themselves change. */
function editorPaths(tabs: ReadonlyArray<{ type: string; data?: unknown }>): string[] {
  return EDITOR_PATHS_CACHE.get(tabs) ?? computeEditorPaths(tabs);
}

const EDITOR_PATHS_CACHE = new WeakMap<object, string[]>();
function computeEditorPaths(tabs: ReadonlyArray<{ type: string; data?: unknown }>): string[] {
  const paths: string[] = [];
  for (const tab of tabs) {
    if (tab.type !== "editor" && tab.type !== "media" && tab.type !== "unsupported") continue;
    const path = (tab.data as { filePath?: unknown } | undefined)?.filePath;
    if (typeof path === "string" && !path.startsWith("untitled:")) paths.push(path);
  }
  EDITOR_PATHS_CACHE.set(tabs, paths);
  return paths;
}

/** The name with the query's characters in the foreground colour and the
 *  rest muted — only while the name holds a match; otherwise the plain text.
 *  Colour alone marks a match: a weight step widens just the matched glyphs,
 *  so a name with scattered matches looks unevenly spaced. */
function Highlighted({ value, indices }: { value: string; indices: ReadonlyArray<number> }) {
  if (indices.length === 0) return <>{value}</>;
  return (
    <span className="text-muted-foreground" data-testid="file-search-name-highlight">
      {highlightSegments(value, indices).map((segment, i) =>
        segment.matched ? (
          <span className="text-foreground" data-match="" key={i}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </span>
  );
}

/** The lucide icon a row draws when the icon theme has none (and under
 *  "Minimal"), by the file's kind. */
function kindIcon(kind: FileKind): FallbackIcon {
  if (kind === "image" || kind === "svg") return ImageIcon;
  if (kind === "video") return Film;
  if (kind === "audio") return Music;
  if (kind === "text") return FileCode;
  return FileX;
}
