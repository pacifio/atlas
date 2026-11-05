/**
 * Projects attached to a session — the wrappers over `session_projects_*`
 * (`src-tauri/src/commands/session_projects.rs`).
 *
 * An attached project is a folder the session may use besides its own, at an
 * access level: read-only by default, read and write when the user grants it.
 * It belongs to the session, not to one message: it outlives the turn, is
 * restored on resume, and rides on the session row (`ThreadRow.attachedProjects`).
 *
 * Every call is keyed by the live ACP session id the tab runs. A change fires
 * `atlas:threads-changed`, so history surfaces re-read without being told.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AttachedProject, AttachSource, ProjectAccess } from "./history-api";

export type { AttachedProject, AttachSource, ProjectAccess } from "./history-api";

/** What an attach, detach or access change did — Rust's `SessionProjectsChange`. */
export interface SessionProjectsChange {
  /** The session's attached projects after the change. */
  projects: AttachedProject[];
  /** `false` when it was already so (the path attached, the access unchanged). */
  changed: boolean;
  /**
   * The agent's sandbox takes the change from the session's next turn. `false`
   * when the agent cannot change an open session's folders (ACP agents) or the
   * session is not open: the change is kept and reaches the agent when the
   * session is next resumed. Atlas's own file access applies at once either way.
   */
  appliedLive: boolean;
}

/** The session's attached projects, in the order they were attached. */
export function listSessionProjects(sessionId: string): Promise<AttachedProject[]> {
  return invoke<AttachedProject[]>("session_projects_list", { sessionId });
}

/**
 * Attach the folder at `path` to the session. Read-only unless `access` says
 * otherwise. Rejects a path that is not a project (the filesystem root, the
 * home folder, system or settings folders) with a message to show as is.
 * Attaching a path that is already attached keeps its access.
 */
export function attachSessionProject(
  sessionId: string,
  path: string,
  opts: { displayName?: string; access?: ProjectAccess; source?: AttachSource } = {},
): Promise<SessionProjectsChange> {
  return invoke<SessionProjectsChange>("session_projects_attach", {
    sessionId,
    path,
    displayName: opts.displayName ?? null,
    access: opts.access ?? null,
    source: opts.source ?? null,
  });
}

/** Detach the project at `path` from the session. */
export function detachSessionProject(
  sessionId: string,
  path: string,
): Promise<SessionProjectsChange> {
  return invoke<SessionProjectsChange>("session_projects_detach", { sessionId, path });
}

/** Change what the session may do in the attached project at `path`. */
export function setSessionProjectAccess(
  sessionId: string,
  path: string,
  access: ProjectAccess,
): Promise<SessionProjectsChange> {
  return invoke<SessionProjectsChange>("session_projects_set_access", {
    sessionId,
    path,
    access,
  });
}
