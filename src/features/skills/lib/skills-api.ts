import { invoke } from "@tauri-apps/api/core";
import { afterSkillMutation } from "./skills-events";
import type {
  AgentTarget,
  PackComponentMeta,
  ReconcileView,
  Scope,
  SkillContent,
  SkillMeta,
} from "./types";

/**
 * Skills on-disk bridge. The canonical `SKILL.md` store + per-agent symlinks
 * are owned Rust-side (`commands/skills.rs`); the frontend only lists, reads,
 * and issues mutations through these wrappers. Disk *is* the state — every
 * mutation refetches rather than locally patching (see `skills-store.ts`).
 *
 * `projectPath` is required for `scope: "project"` and ignored for
 * `scope: "global"`; we pass it through whenever present.
 */
export const skills = {
  list: (scope: Scope, projectPath?: string | null) =>
    invoke<SkillMeta[]>("skills_list", {
      scope,
      projectPath: projectPath ?? null,
    }),

  read: (scope: Scope, name: string, projectPath?: string | null) =>
    invoke<SkillContent>("skills_read", {
      scope,
      name,
      projectPath: projectPath ?? null,
    }),

  /** Invokable pack-delivered components (command/agent/rule) in this scope. */
  componentsList: (scope: Scope, projectPath?: string | null) =>
    invoke<PackComponentMeta[]>("pack_components_list", {
      scope,
      projectPath: projectPath ?? null,
    }),

  setEnabled: (
    scope: Scope,
    name: string,
    agent: string,
    enabled: boolean,
    projectPath?: string | null,
  ) =>
    afterSkillMutation(
      invoke<void>("skills_set_enabled", {
        scope,
        name,
        agent,
        enabled,
        projectPath: projectPath ?? null,
      }),
    ),

  delete: (scope: Scope, name: string, projectPath?: string | null) =>
    afterSkillMutation(
      invoke<void>("skills_delete", {
        scope,
        name,
        projectPath: projectPath ?? null,
      }),
    ),

  /**
   * "Make for all agents": copy an external/single-agent skill into the
   * canonical store and symlink it into every detected agent. Returns the
   * now-managed skill.
   */
  adopt: (scope: Scope, name: string, projectPath?: string | null) =>
    afterSkillMutation(
      invoke<SkillMeta>("skills_adopt", {
        scope,
        name,
        projectPath: projectPath ?? null,
      }),
    ),

  path: (scope: Scope, name: string, projectPath?: string | null) =>
    invoke<string>("skills_path", {
      scope,
      name,
      projectPath: projectPath ?? null,
    }),

  listAgentTargets: (scope: Scope, projectPath?: string | null) =>
    invoke<AgentTarget[]>("agents_list_skill_targets", {
      scope,
      projectPath: projectPath ?? null,
    }),

  // ── Control Plane ──────────────────────────────────────────────────────

  /** Tool registry + per-scope detection facts. */
  toolsList: (scope: Scope, projectPath?: string | null) =>
    invoke<AgentTarget[]>("tools_list", {
      scope,
      projectPath: projectPath ?? null,
    }),

  /** The reconciled skill × tool matrix for a scope. */
  reconcile: (scope: Scope, projectPath?: string | null) =>
    invoke<ReconcileView>("skills_reconcile", {
      scope,
      projectPath: projectPath ?? null,
    }),

  /**
   * Project a canonical skill into one tool at a scope (symlink/copy + ledger).
   * `force` overrides the non-destructive guard (drifted/external) — default false.
   */
  project: (scope: Scope, name: string, tool: string, force = false, projectPath?: string | null) =>
    afterSkillMutation(
      invoke<void>("skills_project", {
        scope,
        name,
        tool,
        force,
        projectPath: projectPath ?? null,
      }),
    ),

  /** Remove a projection (symlink/copy) of a skill from one tool. */
  unproject: (scope: Scope, name: string, tool: string, projectPath?: string | null) =>
    afterSkillMutation(
      invoke<void>("skills_unproject", {
        scope,
        name,
        tool,
        projectPath: projectPath ?? null,
      }),
    ),

  /** Promote a project skill to the global library + re-project at global scope. */
  promote: (name: string, projectPath: string) =>
    afterSkillMutation(invoke<SkillMeta>("skills_promote", { name, projectPath })),

  /** Freeze every Atlas symlink projection into a real copy (uninstall safety). */
  freeze: (scope: Scope, projectPath?: string | null) =>
    afterSkillMutation(
      invoke<void>("skills_freeze", {
        scope,
        projectPath: projectPath ?? null,
      }),
    ),
};
