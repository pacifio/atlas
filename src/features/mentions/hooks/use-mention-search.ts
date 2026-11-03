// The mention picker's search state: the locked scope, the drilled-into past
// session, the provider results, the keyboard cursor and the file-index
// loading hint, with the effects that keep them current while it is open.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  listMessagesInPastSession,
  listPastSessions,
  searchMentions,
  type MentionContext,
  type MentionData,
  type MentionKind,
  type PastSessionRef,
} from "@/features/chat/lib/mentions";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import { ensureFileIndex } from "@/features/file-picker/lib/file-picker-api";
import { activeProjectId } from "@/features/projects/lib/active-project";

export function useMentionSearch({
  open,
  query,
  projectPath,
  agentId,
  tabId,
  excludeIds,
  initialScope,
  activeOrganisationId,
}: {
  open: boolean;
  query: string;
  projectPath: string | null;
  agentId?: string;
  tabId?: string;
  excludeIds?: Set<string>;
  initialScope?: MentionKind | null;
  activeOrganisationId: string | null;
}) {
  const [scope, setScope] = useState<MentionKind | null>(initialScope ?? null);
  /** When scope === "past_message" and no `pastSession` is locked, the
   *  picker shows a sessions list (level 1). Once `pastSession` is set,
   *  it shows messages inside that session (level 2). */
  const [pastSession, setPastSession] = useState<PastSessionRef | null>(null);
  const [pastSessions, setPastSessions] = useState<PastSessionRef[]>([]);
  const [results, setResults] = useState<MentionData[]>([]);
  const [active, setActive] = useState(0);
  /** True until the backend FileIndex finishes its initial walk for the
   *  active project. With multiple projects the first `@`/`~` in a
   *  freshly-switched project can land before its index is built — without
   *  this we'd flash a misleading "No matches" instead of a loading hint. */
  const [indexing, setIndexing] = useState(false);
  /** Bumped when the backend reports the index changed, to re-run the
   *  in-flight search once the walk completes. */
  const [indexNonce, setIndexNonce] = useState(0);

  // Reset transient state when the popover (re-)opens.
  // When `initialScope` is set, lock to that scope — the picker
  // then renders as if the user had drilled into that category.
  useEffect(() => {
    if (open) {
      setScope(initialScope ?? null);
      setPastSession(null);
      setActive(0);
    } else {
      setResults([]);
      setPastSessions([]);
    }
  }, [open, initialScope]);

  // Run providers on every (query, scope, pastSession, projectPath)
  // change. Each provider gets its own AbortSignal so stale results
  // from a prior query get dropped before they hit setState. The
  // past-message scope has its own two-level path:
  //   - no pastSession: load the session list once per scope-entry
  //   - pastSession set: search messages inside that session
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const ctx: MentionContext = { projectPath, agentId, tabId };

    // No debounce — the Rust side reads everything from cached
    // state now (file index, folder list, git refs, knowledge,
    // symbols are all in `MentionCacheState` / `FileIndexState`),
    // so each invoke is sub-millisecond. Firing on every keystroke
    // keeps the picker truly live; the AbortController drops the
    // result of any in-flight invoke if a newer keystroke beat it
    // back, so stale results never paint.
    const applyExcludes = (items: MentionData[]) => {
      if (!excludeIds || excludeIds.size === 0) return items;
      return items.filter((m) => !excludeIds.has(`${m.kind}:${m.id}`));
    };
    if (scope === "past_message" && !pastSession) {
      void listPastSessions(ctx).then((sessions) => {
        if (controller.signal.aborted) return;
        const q = query.trim().toLowerCase();
        const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
        setPastSessions(filtered.slice(0, 30));
        setResults([]);
      });
    } else if (scope === "past_message" && pastSession) {
      void listMessagesInPastSession(pastSession, query, controller.signal).then((msgs) => {
        if (controller.signal.aborted) return;
        setResults(applyExcludes(msgs));
        setPastSessions([]);
      });
    } else {
      void searchMentions(query, scope, ctx).then((r) => {
        if (controller.signal.aborted) return;
        setResults(applyExcludes(r));
        setPastSessions([]);
      });
    }

    return () => controller.abort();
  }, [
    open,
    query,
    scope,
    pastSession,
    projectPath,
    agentId,
    tabId,
    excludeIds,
    indexNonce,
    activeOrganisationId,
  ]);

  // Reset the keyboard cursor to the top ONLY when the user changes what
  // they're looking at (query/scope/session) — NOT when results merely
  // refresh in the background (e.g. the index-build `indexNonce` bump), which
  // would otherwise snap the highlight back to the first item mid-navigation.
  useEffect(() => {
    setActive(0);
  }, [query, scope, pastSession]);

  // Detect whether the active project's file index is still building, for
  // the file-dependent scopes (blended / file / folder). Drives the
  // "Indexing files…" hint so the first `@` in a freshly-opened project
  // shows a loading state instead of "No matches". `ensureFileIndex` returns
  // null on the already-confirmed fast path (→ not indexing).
  useEffect(() => {
    if (!open || !projectPath) {
      setIndexing(false);
      return;
    }
    if (scope !== null && scope !== "file" && scope !== "folder") {
      setIndexing(false);
      return;
    }
    let cancelled = false;
    void ensureFileIndex(projectPath).then((status) => {
      if (cancelled) return;
      setIndexing(status ? !status.indexed : false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, scope]);

  // Flip the loading hint off and re-run the search the moment the backend
  // reports the walk completed (fired by `fileindex_open_project` on initial
  // walk and by the fs-watch debouncer thereafter).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{ workspaceId?: string }>("atlas:fileindex:updated", (ev) => {
      if (cancelled) return;
      // The event carries the owning project — a background reindex for
      // ANOTHER project must not clear this picker's loading hint or
      // re-fire its search.
      const ws = ev.payload?.workspaceId;
      if (ws && ws !== activeProjectId()) return;
      setIndexing(false);
      setIndexNonce((n) => n + 1);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  // Re-run the search when packs change on disk (install, projection,
  // adopt, …) so a freshly installed component shows up without the user
  // reopening the picker. Mirrors the file-index refresh above.
  useEffect(() => {
    if (!open) return;
    const onChanged = () => setIndexNonce((n) => n + 1);
    window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
  }, [open]);

  return {
    scope,
    setScope,
    pastSession,
    setPastSession,
    pastSessions,
    results,
    active,
    setActive,
    indexing,
  };
}
