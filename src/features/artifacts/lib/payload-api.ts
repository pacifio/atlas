/**
 * Reading the full body of a payload the timeline only carries a preview of.
 *
 * Two sources: a Session captured on this machine spilled the payload to the
 * local blob sidecar (addressed by content key); one captured elsewhere was
 * never written here, so the server holds it, addressed by row id and part.
 */

import { invoke } from "@tauri-apps/api/core";

import type { ArtifactPayload } from "../types";
import type { PayloadPart } from "./session-timeline";

export function localPayload(projectPath: string, blobRef: string): Promise<ArtifactPayload> {
  return invoke<ArtifactPayload>("artifacts_payload", { projectPath, blobRef });
}

export function cloudPayload(
  projectId: string | undefined,
  sessionId: string | undefined,
  rowId: string,
  part: PayloadPart,
): Promise<ArtifactPayload> {
  return invoke<ArtifactPayload>("artifacts_cloud_payload", { projectId, sessionId, rowId, part });
}
