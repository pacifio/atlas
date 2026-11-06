// Typed wrappers for every capture command, so no component invokes directly.
// Command names and payload field names are the Rust handlers' argument names —
// `tests/ipc-contract.test.ts` checks the names against `generate_handler![]`.

import { invoke } from "@tauri-apps/api/core";
import type {
  Binding,
  CaptureHealth,
  ConnectOptions,
  ConnectResult,
  Detection,
  ImportPreview,
  PromotionPreview,
  SlugAvailability,
  Visibility,
} from "../types";

/** The project's capture binding, or `null` when capture was never set up. */
export async function captureBinding(projectPath: string): Promise<Binding | null> {
  return (await invoke<Binding | null>("capture_binding", { projectPath })) ?? null;
}

/** Why capture is degraded or stopped, if it is. `workspaceId` is the Atlas
 *  project id (the storage key is still called a workspace). An unmocked read
 *  in the browser harness resolves `null`. */
export async function captureHealth(
  projectPath: string,
  workspaceId: string | null,
): Promise<CaptureHealth | null> {
  return (
    (await invoke<CaptureHealth | null>("capture_health", { projectPath, workspaceId })) ?? null
  );
}

/** What Atlas worked out about this directory (git, origin, suggested Slug). */
export function captureDetect(projectPath: string): Promise<Detection> {
  return invoke<Detection>("capture_detect", { projectPath });
}

/** The read-only numbers a history import would disclose. */
export function captureImportPreview(projectPath: string): Promise<ImportPreview> {
  return invoke<ImportPreview>("capture_import_preview", { projectPath });
}

/** Is `git` on this machine at all? */
export function captureGitAvailable(): Promise<boolean> {
  return invoke<boolean>("capture_git_available");
}

/** The read-only numbers a Local→Cloud promotion would publish. */
export function capturePromotionPreview(projectPath: string): Promise<PromotionPreview> {
  return invoke<PromotionPreview>("capture_promotion_preview", { projectPath });
}

/** Restart the git watcher and answer with the health that results. */
export function captureRetryWatcher(
  projectPath: string,
  workspaceId: string | null,
): Promise<CaptureHealth> {
  return invoke<CaptureHealth>("capture_retry_watcher", { projectPath, workspaceId });
}

/**
 * Bind (or re-enable) this project. Always `"local"`: the command rejects
 * `"cloud"` outright, and an existing Cloud binding keeps its mode on re-enable.
 */
export function captureEnableLocal(projectPath: string): Promise<unknown> {
  return invoke("capture_enable", { projectPath, mode: "local" });
}

export function captureDisable(projectPath: string): Promise<unknown> {
  return invoke("capture_disable", { projectPath });
}

export function captureGitInit(projectPath: string): Promise<unknown> {
  return invoke("capture_git_init", { projectPath });
}

/** Re-send the rows that failed to sync — a deliberate human action. */
export function captureRetryFailed(projectPath: string): Promise<unknown> {
  return invoke("capture_retry_failed", { projectPath });
}

/** Approve the bulk history import for this project. */
export function captureImportConfirm(projectPath: string): Promise<unknown> {
  return invoke("capture_import_confirm", { projectPath });
}

/** Register a bound project as a new Cloud Project. Needs an existing binding. */
export function captureRegisterCloud(args: {
  projectPath: string;
  orgId: string;
  slug: string;
  name: string | null;
  visibility: Visibility;
  gitUrl: string;
}): Promise<unknown> {
  const { projectPath, orgId, slug, name, visibility, gitUrl } = args;
  return invoke("capture_register_cloud", {
    projectPath,
    orgId,
    slug,
    name,
    visibility,
    gitUrl,
  });
}

/** Local→Cloud promotion onto a NEW Project. */
export function capturePromote(args: {
  projectPath: string;
  orgId: string;
  slug: string;
  name: string | null;
  visibility: Visibility;
}): Promise<unknown> {
  const { projectPath, orgId, slug, name, visibility } = args;
  return invoke("capture_promote", {
    projectPath,
    orgId,
    slug,
    name,
    visibility,
  });
}

/** Attach this project to a Project the Organisation already has. */
export function captureConnect(args: {
  projectPath: string;
  orgId: string;
  slug: string;
  workspaceId: string;
}): Promise<ConnectResult> {
  const { projectPath, orgId, slug, workspaceId } = args;
  return invoke<ConnectResult>("capture_connect", {
    projectPath,
    orgId,
    slug,
    workspaceId,
  });
}

/** Cloud→Cloud: move this project's sync to a different Project. */
export function captureSwitchProject(args: {
  projectPath: string;
  orgId: string;
  slug: string;
  workspaceId: string;
}): Promise<ConnectResult> {
  const { projectPath, orgId, slug, workspaceId } = args;
  return invoke<ConnectResult>("capture_switch_project", {
    projectPath,
    orgId,
    slug,
    workspaceId,
  });
}

/** The Organisation's Projects Connect can offer, with the server's pre-pick. */
export function captureConnectOptions(projectPath: string, orgId: string): Promise<ConnectOptions> {
  return invoke<ConnectOptions>("capture_connect_options", { projectPath, orgId });
}

/** Is this Slug free in the Organisation? `unknown` means the network blinked. */
export function captureSlugAvailable(
  projectPath: string,
  orgId: string,
  slug: string,
): Promise<SlugAvailability> {
  return invoke<SlugAvailability>("capture_slug_available", {
    projectPath,
    orgId,
    slug,
  });
}
