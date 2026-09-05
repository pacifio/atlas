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

/**
 * Tab types whose CONTENT belongs to one Organisation — their ids and data
 * embed conversation/draft ids that exist in exactly one org.
 *
 * Two consequences, both load-bearing:
 *  - they are closed on every org change (`switchOrg`, and the boot
 *    reconciliation branch in the comms store);
 *  - they are NEVER written to the per-project editor state. That file is
 *    keyed by PROJECT PATH, and the same path is commonly open in several
 *    orgs — a persisted Space tab came back on the incoming org's mount
 *    pointing at the outgoing org's conversation ("This Space is no longer
 *    available"), which is what closing alone could not fix.
 *
 * Settings is deliberately absent: it is projectless but org-agnostic.
 */
export const ORG_SCOPED_TYPES: ReadonlySet<TabType> = new Set<TabType>(["comms-draft", "spaces"]);
