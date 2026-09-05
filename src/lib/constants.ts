export const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "settings",
  "log",
  "media",
  "svg",
  "pdf",
  "unsupported",
  "mission-control",
  "artifacts",
  "comms-draft",
  "spaces",
] as const;

export type TabType = (typeof TAB_TYPES)[number];

/**
 * Tab types that work with NO project open — org-scoped surfaces, not
 * workspace ones. The projectless centre shell renders only these; the rest
 * of a workspace's tabs stay in the store untouched and reappear when a
 * project opens.
 */
export const PROJECTLESS_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  "settings",
  "comms-draft",
  "spaces",
]);
