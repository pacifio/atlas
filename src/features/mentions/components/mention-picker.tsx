// Floating mention picker. Anchored to a fixed coordinate (the caret of the
// `@` in the CodeMirror composer), driven by an imperative keyboard API so
// the editor never loses focus.
//
// Two views (Linear-style — search-first, no category step):
//   • No scope locked: ONE blended search across every kind, rendered as
//     per-kind sections (Files / Knowledge / Cloned Repos / …) in the order
//     the ranked results surface them. Empty query shows a zero-query
//     overview (recents + a slice of each kind) with a "Browse" category
//     tail as an escape hatch for explicit scoping + past messages.
//   • Scope locked (category pick, `~`, or an alias like `@note `): results
//     from that kind only.
//
// Keyboard contract: the parent component forwards Up/Down/Enter/Esc via
// the imperative handle so CM's focus stays put — the picker never has
// DOM focus.
//
// This file is the container: the stores it reads, the search state
// (`use-mention-search.ts`), the row model (`lib/mention-picker-rows.ts`) and
// the keyboard handle. The panel itself is `views/mention-picker-popover.tsx`.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

import type { MentionData, MentionKind } from "@/features/chat/lib/mentions";
import { useRecentFilesStore } from "@/features/chat/stores/recent-files-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useAttachedProjects } from "@/features/chat/hooks/use-session-roots";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useMentionSearch } from "../hooks/use-mention-search";
import { buildMentionRows, type Row } from "../lib/mention-picker-rows";
import { MentionPickerPopover } from "./views/mention-picker-popover";

// ── Public API ───────────────────────────────────────────────────────────────

export interface MentionPickerHandle {
  /** Move the active row down by 1. Wraps. */
  moveDown(): void;
  /** Move the active row up by 1. Wraps. */
  moveUp(): void;
  /** Commit the active row. Returns true if a real selection happened
   *  (mention inserted, or scope locked). False if there were no results
   *  so the parent can decide what Enter does in that case. */
  commit(): boolean;
  /** Pop one level back. Returns true if we actually went back (picker
   *  was at a sub-level), false if there's nothing above the current
   *  level (so the parent can close / delete a char). */
  goBack(): boolean;
}

export interface MentionPickerProps {
  /** When false, the popover unmounts and providers stop firing. */
  open: boolean;
  /** Query text typed after the `@` (excluding the `@` itself). */
  query: string;
  /** Caret position in viewport coords, used to anchor the popover. */
  anchor: { x: number; y: number } | null;
  /** Active project root — required for project-scoped sources. */
  projectPath: string | null;
  /** Active chat agent's skill-registry id. When set, pack-component
   *  mentions (command/agent/rule) only list ones enabled for this agent. */
  agentId?: string;
  /** The chat tab this picker types into. Comments on that tab's recorded
   *  session are offered only when it is given. */
  tabId?: string;
  /** A mention was picked. Parent inserts the chip. */
  onSelect: (mention: MentionData) => void;
  /** Picker closed itself (Esc, no anchor, etc). */
  onClose: () => void;
  /** Optional `${kind}:${id}` set whose entries are hidden from the
   *  results (e.g. the knowledge editor passes the currently-open note
   *  so users can't @-reference the document they're editing). */
  excludeIds?: Set<string>;
  /** Additional CSS selectors that, if any ancestor matches, should
   *  NOT trigger an outside-click dismiss. Always includes
   *  `.atlas-chat-composer` and `.atlas-mention-picker`; callers in
   *  other surfaces (Tiptap, future composers) add their own. */
  hostSelectors?: string[];
  /** Lock the picker to a single kind from the moment it opens —
   *  skips the "Recents + Browse categories" empty view and goes
   *  straight to filtered results. Used by the kb editor's `#`
   *  trigger to scope the picker to knowledge notes only. */
  initialScope?: MentionKind | null;
}

// ── Picker component ────────────────────────────────────────────────────────

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  function MentionPicker(
    {
      open,
      query,
      anchor,
      projectPath,
      agentId,
      tabId,
      onSelect,
      onClose,
      excludeIds,
      hostSelectors,
      initialScope,
    },
    ref,
  ) {
    const recentFiles = useRecentFilesStore.use.items();
    // The session this picker types into, for the projects attached to it.
    const sessionId = useChatStore((s) =>
      tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null,
    );
    const attached = useAttachedProjects(sessionId);
    // Project mentions are scoped to the active org (see `searchProjects`).
    // Subscribe so switching orgs re-runs the search and the list reflects the
    // new org's projects even while the picker stays mounted.
    const activeOrganisationId = useOrgStore.use.activeOrganisationId();
    const {
      scope,
      setScope,
      pastSession,
      setPastSession,
      pastSessions,
      results,
      active,
      setActive,
      indexing,
    } = useMentionSearch({
      open,
      query,
      projectPath,
      agentId,
      tabId,
      excludeIds,
      initialScope,
      activeOrganisationId,
    });

    // Build the renderable row list (`buildMentionRows`).
    const rows = useMemo<Row[]>(
      () =>
        buildMentionRows({
          scope,
          pastSession,
          pastSessions,
          results,
          attached,
          query,
          recentFiles,
          projectPath,
          tabId,
        }),
      [scope, query, results, recentFiles, projectPath, tabId, attached],
    );

    // Compute the navigable rows (skip headers). `active` is an index into
    // *navigable* rows, not the full list; the renderer maps it back.
    const navIndices = useMemo(() => {
      const idxs: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].type !== "header") idxs.push(i);
      }
      return idxs;
    }, [rows]);

    useEffect(() => {
      if (active >= navIndices.length) setActive(0);
    }, [active, navIndices.length]);

    const activeRowIdx = navIndices[active];
    const activeRow: Row | undefined = activeRowIdx === undefined ? undefined : rows[activeRowIdx];

    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useImperativeHandle(
      ref,
      (): MentionPickerHandle => ({
        moveDown: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a + 1) % navIndices.length);
        },
        moveUp: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a - 1 + navIndices.length) % navIndices.length);
        },
        commit: () => {
          if (!activeRow) return false;
          if (activeRow.type === "category") {
            setScope(activeRow.cat.kind);
            setActive(0);
            return true;
          }
          if (activeRow.type === "session") {
            setPastSession(activeRow.session);
            setActive(0);
            return true;
          }
          if (activeRow.type === "mention") {
            onSelectRef.current(activeRow.mention);
            return true;
          }
          return false;
        },
        goBack: () => {
          if (pastSession) {
            setPastSession(null);
            setActive(0);
            return true;
          }
          // When a scope was locked from the outside (initialScope),
          // there's no "above" level to drop to — let the parent close.
          if (scope && !initialScope) {
            setScope(null);
            setActive(0);
            return true;
          }
          return false;
        },
      }),
      [activeRow, navIndices.length, pastSession, scope, initialScope],
    );

    // Dismiss on click outside the picker AND outside the host editor.
    // Defaults cover the chat composer (.atlas-chat-composer); other
    // surfaces (Tiptap, future composers) pass their own selectors via
    // `hostSelectors` so a click inside their editable doesn't dismiss.
    const hostSelectorsRef = useRef(hostSelectors);
    hostSelectorsRef.current = hostSelectors;
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".atlas-chat-composer")) return;
        if (target.closest(".atlas-mention-picker")) return;
        const extras = hostSelectorsRef.current;
        if (extras) {
          for (const sel of extras) {
            if (target.closest(sel)) return;
          }
        }
        onCloseRef.current();
      };
      // Mousedown so we beat click handlers inside the editor.
      window.addEventListener("mousedown", handler);
      return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    if (!open || !anchor) return null;

    return (
      <MentionPickerPopover
        anchor={anchor}
        rows={rows}
        activeRowIdx={activeRowIdx}
        navIndices={navIndices}
        setActive={setActive}
        setScope={setScope}
        setPastSession={setPastSession}
        onSelect={onSelectRef}
        indexing={indexing}
        scope={scope}
        pastSession={pastSession}
        query={query}
        projectPath={projectPath}
      />
    );
  },
);
