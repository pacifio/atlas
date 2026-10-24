// Skills feature — shared types. These mirror the Rust `commands/skills.rs`
// IPC contract exactly (serde emits camelCase). The frontend never touches the
// filesystem; all skill state flows through `skills-api.ts` → `invoke()`.

/** Where a skill's canonical `SKILL.md` lives. */
export type Scope = "global" | "project";

/**
 * How an agent receives a skill. `native-dir` = symlink into the agent's
 * skills folder (zero token cost, v1). `inject` = prompt-block fallback
 * (reserved, not built). `unsupported` = the agent can't take skills.
 */
export type Delivery = "native-dir" | "inject" | "unsupported";

/** A skill discovered on disk (the "Installed" set). */
export interface SkillMeta {
  name: string;
  description: string;
  scope: Scope;
  /** Agent ids this skill is currently enabled for (symlink present). */
  enabledAgents: string[];
  /** Absolute path to the canonical `SKILL.md`. */
  path: string;
  delivery: Delivery;
  /**
   * `true` when the skill lives in Atlas's canonical `.atlas/skills` store
   * (Atlas authored or adopted it). `false` for external skills that only
   * exist as a real directory inside an agent's skills dir (e.g. a
   * globally-installed Claude Code skill). External skills can be adopted via
   * "Make for all agents".
   */
  managed: boolean;
  /**
   * When this skill is *provided by an installed pack* (not authored in the
   * canonical store), the originating pack name. Absent for authored/external
   * skills. Pack-provided skills are still `#skill:`-invokable; manage their
   * tool projection from the Packs tab.
   */
  pack?: string | null;
}

/** Invokable pack-delivered component kinds (their body is a usable prompt). */
export type PackComponentKind = "command" | "agent" | "rule";

/**
 * An invokable component (command/agent/rule) shipped by an installed pack.
 * Mirrors the Rust `PackComponentMeta` (serde camelCase). Surfaced in the
 * Installed list and the `#<kind>:` mention rail. Read-only — projection of
 * these into tools is managed from the pack's dialog.
 */
export interface PackComponentMeta {
  pack: string;
  kind: PackComponentKind;
  name: string;
  /** Component path within the pack store (e.g. `commands/ship.md`). */
  relPath: string;
  /** Absolute path to the component body file. */
  path: string;
  description: string;
  /** Registry tool ids (agents) this component is projected to / enabled for.
   *  Empty = not projected anywhere. Drives per-agent gating in the `#` rail. */
  enabledAgents: string[];
}

/** Full body of one skill, for the detail view. */
export interface SkillContent {
  name: string;
  description: string;
  /** The markdown body, frontmatter stripped. */
  body: string;
  /** The raw file contents including frontmatter. */
  raw: string;
}

/** An agent the panel can enable/disable a skill for. */
export interface AgentTarget {
  id: string;
  displayName: string;
  /** Absolute path to where this agent reads skills from. */
  skillsDir: string;
  delivery: Delivery;
  /** Whether the agent's config dir exists in this scope. */
  detected: boolean;
}

// ── Control Plane (reconcile) ──────────────────────────────────────────────
// Mirror the Rust `commands/skills.rs` reconcile structs (serde camelCase).

/** A tool's registry facts in the reconciled view. */
export interface ToolInfo {
  id: string;
  displayName: string;
  detectedGlobal: boolean;
  detectedProject: boolean;
  supportsSymlink: boolean;
  delivery: Delivery;
}

/**
 * Status of one (skill, tool, scope) cell:
 * - `canonical`  — the source row lives in Atlas's `.atlas/skills`.
 * - `synced`     — a projection (symlink, or copy whose hash == canonical).
 * - `drifted`    — a copy whose hash ≠ canonical (edited out-of-band).
 * - `external`   — a real skill Atlas didn't author (no canonical twin).
 * - `conflict`   — external name collides with a canonical skill, content differs.
 * - `absent`     — tool detected, skill not present there.
 * - `pack`       — projection owned by an installed pack (read-only here; manage
 *                  it from the Packs tab).
 */
export type ProjectionStatus =
  | "canonical"
  | "synced"
  | "drifted"
  | "external"
  | "conflict"
  | "absent"
  | "pack";

/** One cell of the skill × tool matrix. */
export interface ProjectionCell {
  tool: string;
  scope: Scope;
  status: ProjectionStatus;
  /** `"symlink"` | `"copy"` | null. */
  mode: "symlink" | "copy" | null;
  /** Owning pack name when `status === "pack"`. */
  pack?: string | null;
}

/** One reconciled skill row: canonical facts + the per-tool matrix. */
export interface ReconciledSkill {
  name: string;
  description: string;
  scope: Scope;
  managed: boolean;
  /** Set when this skill is provided by an installed pack (origin badge). */
  pack?: string | null;
  cells: ProjectionCell[];
}

/** The full reconciled view for one scope. */
export interface ReconcileView {
  tools: ToolInfo[];
  skills: ReconciledSkill[];
}
