// The mention picker's row model: the rows it renders, how they are built from
// the search results, and the labels each row shows. Pure — no React, no
// stores — so the picker's container and its views share one definition.

import { shortPath } from "@/lib/paths";
import { timeAgo } from "@/lib/time-ago";
import {
  MENTION_CATEGORIES,
  categoryForKind,
  type MentionCategory,
  type MentionData,
  type MentionKind,
  type PastSessionRef,
} from "@/features/chat/lib/mentions";
import type { RecentFile } from "@/features/chat/stores/recent-files-store";
import type { AttachedProject } from "@/features/chat/lib/history-api";

/** One renderable row. Either a real mention or a category header (which
 *  acts as a scope-lock button when activated), or — for the Past Messages
 *  scope only — a "session" row that drills into that session's messages. */
export type Row =
  | { type: "header"; label: string }
  | { type: "category"; cat: MentionCategory }
  | { type: "mention"; mention: MentionData; recentLabel?: string }
  | { type: "session"; session: PastSessionRef };

const RECENT_LIMIT = 5;

/** Build the renderable row list. Order:
 *    no scope + empty query → Recents (header) → files → Categories header → categories
 *    no scope + query       → blended results sorted by rank
 *    scope locked           → header showing scope → results in that scope */
export function buildMentionRows({
  scope,
  pastSession,
  pastSessions,
  results,
  attached,
  query,
  recentFiles,
  projectPath,
  tabId,
}: {
  scope: MentionKind | null;
  pastSession: PastSessionRef | null;
  pastSessions: PastSessionRef[];
  results: MentionData[];
  attached: readonly AttachedProject[];
  query: string;
  recentFiles: RecentFile[];
  projectPath: string | null;
  tabId: string | undefined;
}): Row[] {
  const out: Row[] = [];
  if (scope === "past_message" && !pastSession) {
    out.push({ type: "header", label: "Past Messages · pick a session" });
    if (pastSessions.length === 0) {
      // No matches; header alone — the empty-state block below handles
      // copy when there's nothing else to show.
      return out;
    }
    for (const s of pastSessions) {
      out.push({ type: "session", session: s });
    }
    return out;
  }
  if (scope === "past_message" && pastSession) {
    out.push({
      type: "header",
      label: `↶ ${pastSession.title}`,
    });
    for (const m of results) {
      out.push({ type: "mention", mention: m });
    }
    return out;
  }
  // The projects attached to this session lead, with their access, so
  // mentioning one again is a keystroke. They answer the unscoped view
  // and the project scopes; the same folder is not listed twice below.
  const attachedRows = scope === null || scope === "workspace" || scope === "repo";
  const pinned = attachedRows ? attachedMentions(attached, query) : [];
  const pinnedPaths = new Set(pinned.map((p) => p.mention.absPath));
  const notPinned = (m: MentionData) =>
    !((m.kind === "workspace" || m.kind === "repo") && pinnedPaths.has(m.absPath));
  if (pinned.length > 0) {
    out.push({ type: "header", label: "Attached to this session" });
    for (const p of pinned) {
      out.push({ type: "mention", mention: p.mention, recentLabel: p.label });
    }
  }
  if (scope) {
    // Group results under per-kind sub-headers. Homogeneous scopes collapse
    // to a single header (unchanged); the "component" scope (pack-delivered
    // commands/agents/rules) splits into Commands / Agents / Rules.
    const groupOf = (m: MentionData): { key: string; label: string } => {
      if (m.kind === "component") {
        const label =
          m.componentKind === "command"
            ? "Commands"
            : m.componentKind === "agent"
              ? "Agents"
              : "Rules";
        return { key: `component:${m.componentKind}`, label };
      }
      return { key: m.kind, label: categoryForKind(m.kind).label };
    };
    let lastKey: string | null = null;
    let scoped = 0;
    for (const m of results) {
      if (!notPinned(m)) continue;
      const g = groupOf(m);
      if (g.key !== lastKey) {
        out.push({ type: "header", label: g.label });
        lastKey = g.key;
      }
      out.push({ type: "mention", mention: m });
      scoped++;
    }
    // Keep the scope header visible even with zero results (empty-state copy
    // renders below it).
    if (scoped === 0 && pinned.length === 0) {
      out.push({ type: "header", label: categoryForKind(scope).label });
    }
    return out;
  }
  // Unscoped: ONE blended ranked list across every kind, rendered as
  // per-kind sections. Section order = first appearance in the ranked
  // results, so the best-scoring kind leads (Linear-style). Bucketing
  // (rather than a header on every kind flip) keeps each kind together
  // even when scores interleave.
  const emptyQuery = !query.trim();
  // The recents mirror is a single global store reflecting the ACTIVE
  // project; right after a project switch there's an async window
  // where it still holds the previous project's files. Filter to THIS
  // picker's project so a recent from another project can never surface.
  const recents = emptyQuery
    ? recentFiles
        .filter(
          (r) =>
            !projectPath || r.absPath === projectPath || r.absPath.startsWith(projectPath + "/"),
        )
        .slice(0, RECENT_LIMIT)
    : [];
  const recentIds = new Set(recents.map((r) => r.absPath));
  if (recents.length > 0) {
    out.push({ type: "header", label: "Recent files" });
    for (const r of recents) {
      out.push({
        type: "mention",
        mention: recentToMention(r),
        recentLabel: dirOf(r.rel),
      });
    }
  }
  const buckets = new Map<string, MentionData[]>();
  for (const m of results) {
    // In the overview, a file already shown under Recents is noise twice.
    if (emptyQuery && m.kind === "file" && recentIds.has(m.id)) continue;
    if (!notPinned(m)) continue;
    const label = categoryForKind(m.kind).label;
    const bucket = buckets.get(label);
    if (bucket) bucket.push(m);
    else buckets.set(label, [m]);
  }
  for (const [label, items] of buckets) {
    out.push({ type: "header", label });
    for (const m of items) {
      out.push({ type: "mention", mention: m });
    }
  }
  // Escape hatch for explicit scoping (and the kinds that need a
  // drill-in flow, e.g. Past Messages). Only in the zero-query view —
  // once the user types, results ARE the interface.
  if (emptyQuery) {
    out.push({ type: "header", label: "Browse" });
    for (const cat of MENTION_CATEGORIES) {
      // Comments belong to a chat's recorded session; a surface with no
      // chat tab (the notes editor) has none to offer.
      if (cat.kind === "comment" && !tabId) continue;
      out.push({ type: "category", cat });
    }
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The session's attached projects that match `query`, as project mentions,
 *  each with its access as the row's second label. */
function attachedMentions(
  attached: readonly AttachedProject[],
  query: string,
): { mention: Extract<MentionData, { kind: "workspace" }>; label: string }[] {
  const q = query.trim().toLowerCase();
  return attached
    .filter(
      (p) => !q || p.displayName.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    )
    .map((p) => ({
      mention: {
        kind: "workspace" as const,
        id: p.path,
        displayName: p.displayName,
        absPath: p.path,
        orgName: null,
      },
      label: p.access === "read_write" ? "Read & write" : "Read only",
    }));
}

function recentToMention(r: RecentFile): MentionData {
  return {
    kind: "file",
    id: r.absPath,
    displayName: r.rel,
    absPath: r.absPath,
  };
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

/** Primary label shown big in the picker row — last path segment, title,
 *  symbol name, etc. "Name first, parent second" layout. */
export function primaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return basenameOf(m.displayName);
    default:
      return m.displayName;
  }
}

export function secondaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return dirOf(m.displayName);
    case "symbol":
      return `${m.symbolKind} · ${shortPath(m.filePath)}`;
    case "knowledge":
      return m.folder ? `${m.folder} · ${m.source}` : m.source;
    case "component":
      return `${m.componentKind} · pack: ${m.pack}`;
    case "repo":
      return m.hasReadme ? "cloned · README" : "cloned";
    case "workspace":
      return m.orgName ? `${m.orgName} · ${shortPath(m.absPath)}` : shortPath(m.absPath);
    case "branch":
      return m.refKind + (m.isCurrent ? " · HEAD" : "");
    case "past_message":
      return m.sessionTitle;
    case "past_session":
      return "session transcript";
    case "member":
      return m.email;
    case "conversation":
      return m.conversationKind === "channel"
        ? "channel"
        : m.conversationKind === "group_dm"
          ? "group DM"
          : "direct message";
    case "recorded_session":
      return "recorded session · Timeline";
    case "pasted_text":
      return `${m.lines} lines`;
    case "cited_text":
      return "cited passage";
    case "review_comment":
      return `review comment · ${m.rangeLabel}`;
    case "agent_context":
      return "context";
    case "comment":
      return [
        m.parentId ? "reply" : "comment",
        `on ${m.anchorLabel}`,
        timeAgo(m.createdAt, { suffix: true }),
        m.resolved ? "resolved" : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function basenameOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

export function emptyStateCopy(args: {
  scope: MentionKind | null;
  pastSession: boolean;
  query: string;
  hasProject: boolean;
}): string {
  if (!args.hasProject) return "Open a project to browse references.";
  if (args.scope === "past_message" && !args.pastSession) {
    return args.query
      ? `No saved conversations matching "${args.query}".`
      : "No saved conversations in this project yet.";
  }
  if (args.scope === "past_message" && args.pastSession) {
    return args.query
      ? `No user messages matching "${args.query}".`
      : "No user messages in this session.";
  }
  if (args.scope === "comment") {
    return args.query
      ? `No comments matching "${args.query}".`
      : "No comments on this session yet — comments appear once it is in the cloud.";
  }
  if (args.scope) {
    const label = MENTION_CATEGORIES.find((c) => c.kind === args.scope)?.label ?? args.scope;
    return args.query
      ? `No ${label.toLowerCase()} matching "${args.query}".`
      : `No ${label.toLowerCase()} indexed yet.`;
  }
  return args.query
    ? `No matches for "${args.query}".`
    : "Type to search files, folders, notes, repos, branches…";
}

export function mentionTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":
      return m.absPath;
    case "folder":
      return m.absPath;
    case "symbol":
      return `${m.filePath}:${m.line}`;
    case "knowledge":
      return m.filePath;
    case "component":
      return m.description || m.filePath;
    case "repo":
      return m.absPath;
    case "workspace":
      return m.absPath;
    case "branch":
      return `${m.refKind} ${m.id} (${m.sha.slice(0, 7)})`;
    case "past_message":
      return m.content;
    case "past_session":
      return m.sessionTitle;
    case "member":
      return `${m.displayName} <${m.email}>`;
    case "conversation":
      return m.displayName;
    case "recorded_session":
      return `Recorded session ${m.sessionId}`;
    case "comment":
      return `${m.authorName}: ${m.body}`;
    case "pasted_text":
      return m.text.slice(0, 200);
    case "cited_text":
      return m.text.slice(0, 200);
    case "review_comment":
      return m.text.slice(0, 200);
    case "agent_context":
      return m.displayName;
  }
}
