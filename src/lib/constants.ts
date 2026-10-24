export const TAB_TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "files",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "commit",
  "session-changes",
  "pull-request",
  "pull-requests",
  "session-pull-requests",
  "source-control",
  "log",
  "media",
  "svg",
  "pdf",
  "notebook",
  "unsupported",
  "usage",
  "artifacts",
  "comms-draft",
  "spaces",
  "team-chat",
] as const;

export type TabType = (typeof TAB_TYPES)[number];

/**
 * Tab types that work with NO project open — org-scoped surfaces, not
 * project ones. The projectless centre shell renders only these; the rest
 * of a project's tabs stay in the store untouched and reappear when a
 * project opens.
 */
export const PROJECTLESS_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  "comms-draft",
  "spaces",
  "usage",
  "team-chat",
]);

/**
 * Tab types that belong to the WINDOW, not to a project: one per window, and
 * they follow the user from project to project instead of staying behind in
 * the project they were opened in.
 *
 * Team chat is the one: it is the same conversation whichever project is
 * open. It is not org-scoped — nothing in the tab names an org, and the panel
 * retargets with the socket — so an org switch leaves it open. It is never
 * written to the per-project editor state; whether it was open is a layout
 * preference (`teamChat.open`), restored on boot.
 */
export const WINDOW_TYPES: ReadonlySet<TabType> = new Set<TabType>(["team-chat"]);

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
export const ORG_SCOPED_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  "comms-draft",
  "spaces",
  "usage",
]);

/**
 * Where a tab type opens (ADR-0024):
 *
 *  - `session`: the session column, which shows no tab strip.
 *  - `surface`: a tab in the surfaces pane beside the session. `minWidth` is
 *    the narrowest its layout still works at, in CSS pixels; a column showing
 *    it will not resize below that.
 *  - `destination`: a full-page view that takes the area right of the rail,
 *    one at a time, while the session runs underneath.
 *  - `surface-or-destination`: either, by how it was opened, and one at a
 *    time across both forms: opening it in one form moves it out of the
 *    other. For a tool that passes the surface test AND is a place in its own
 *    right (team chat, amended into ADR-0024). `minWidth` is its floor as a
 *    surface.
 *
 * The test: do you use it WHILE working in a session, and does it have a
 * useful form at column width (about 320–600px)? Yes to both is a surface; no
 * to either is a destination. A destination that someone needs beside the
 * session gets a peek, a compact view designed for a column, never its full
 * page squeezed into one.
 *
 * A `Record`, so adding a tab type without a placement does not compile.
 */
export type Placement =
  | { kind: "session" }
  | { kind: "surface"; minWidth: number }
  | { kind: "destination" }
  | { kind: "surface-or-destination"; minWidth: number };

export const TAB_PLACEMENT = {
  chat: { kind: "session" },

  editor: { kind: "surface", minWidth: 320 },
  // The project tree: used while a session works, and a tree is a column's
  // natural shape, so a surface.
  files: { kind: "surface", minWidth: 240 },
  terminal: { kind: "surface", minWidth: 280 },
  browser: { kind: "surface", minWidth: 360 },
  diff: { kind: "surface", minWidth: 360 },
  commit: { kind: "surface", minWidth: 360 },
  "session-changes": { kind: "surface", minWidth: 320 },
  // One pull request: read and acted on while the session that opened it
  // works, and its header, Summary and composer are built for a column.
  "pull-request": { kind: "surface", minWidth: 360 },
  // A repository's pull requests: scanned while a session works, to pick the
  // next one to open beside it, and its rows and filter bar fit a column.
  "pull-requests": { kind: "surface", minWidth: 360 },
  // One session's linked pull requests: glanced at while that session works
  // (is the stack green, did review land), and a list of rows is a column's
  // natural shape.
  "session-pull-requests": { kind: "surface", minWidth: 320 },
  "source-control": { kind: "surface", minWidth: 300 },
  // A surface beside a session (a reply while the agent works) and a
  // destination of its own (reading the team's conversations full width).
  // ADR-0024's 2026-10-24 amendment.
  "team-chat": { kind: "surface-or-destination", minWidth: 320 },
  "comms-draft": { kind: "surface", minWidth: 320 },
  log: { kind: "surface", minWidth: 300 },
  pdf: { kind: "surface", minWidth: 320 },
  notebook: { kind: "surface", minWidth: 360 },
  media: { kind: "surface", minWidth: 240 },
  svg: { kind: "surface", minWidth: 240 },
  unsupported: { kind: "surface", minWidth: 240 },
  // Retired; a saved one still renders its placeholder.
  tasks: { kind: "surface", minWidth: 240 },

  artifacts: { kind: "destination" },
  usage: { kind: "destination" },
  knowledge: { kind: "destination" },
  "knowledge-graph": { kind: "destination" },
  memory: { kind: "destination" },
  canvas: { kind: "destination" },
  spaces: { kind: "destination" },
} as const satisfies Record<TabType, Placement>;

type PlacementKind<K extends TabType> = (typeof TAB_PLACEMENT)[K]["kind"];

/** The tab types that can show as a destination (only, or as one of two
 *  forms), as a type, so a map keyed by it (the destination screen's panels,
 *  their titles) must cover every one. */
export type DestinationType = {
  [K in TabType]: PlacementKind<K> extends "destination" | "surface-or-destination" ? K : never;
}[TabType];

/** The tab types that are only ever destinations: never a column's tab. */
export type DestinationOnlyType = {
  [K in TabType]: PlacementKind<K> extends "destination" ? K : never;
}[TabType];

/** The tab types that open in either form (`surface-or-destination`). */
export type DualPlacementType = {
  [K in TabType]: PlacementKind<K> extends "surface-or-destination" ? K : never;
}[TabType];

/** Whether `type` can show on the destination screen, in either placement. */
export function isDestination(type: TabType): type is DestinationType {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "destination" || p.kind === "surface-or-destination";
}

/** Whether `type` is only ever a destination: never in a column, never in
 *  the per-project editor state. What the layout store routes by. */
export function isDestinationOnly(type: TabType): type is DestinationOnlyType {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "destination";
}

/** Whether `type` opens in either form, by how it was opened. */
export function isDualPlacement(type: TabType): type is DualPlacementType {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "surface-or-destination";
}

/** The narrowest a column showing `type` may be, in CSS pixels; `null` for a
 *  type that never sits in a surfaces column. */
export function surfaceMinWidth(type: TabType): number | null {
  const p: Placement = TAB_PLACEMENT[type];
  return p.kind === "surface" || p.kind === "surface-or-destination" ? p.minWidth : null;
}

/**
 * Tab types that were renamed. Persisted layout / editor state written by an
 * older build still carries the old name; `migrateTabType` maps it forward so
 * the tab comes back instead of being dropped as unknown.
 */
export const LEGACY_TAB_TYPES: Record<string, TabType> = { "mission-control": "usage" };

/** The current name for a stored tab type: the mapped type for a legacy name,
 *  the type itself when it is still valid, `null` when it is neither. */
export function migrateTabType(type: string): TabType | null {
  const legacy = LEGACY_TAB_TYPES[type];
  if (legacy) return legacy;
  return (TAB_TYPES as readonly string[]).includes(type) ? (type as TabType) : null;
}
