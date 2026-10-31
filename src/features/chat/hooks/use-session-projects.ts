/**
 * The composer's handles on a session's attached projects.
 *
 * `SessionProjectsContext` hands the chips the session id. Chip node views
 * render inside the editor's React tree, so a provider around the composer
 * reaches them. The list itself is in `session-projects-store`, kept current
 * by the composer's history read (`use-live-elsewhere-feed.ts`).
 */

import { createContext, useContext } from "react";
import { toast } from "sonner";

import type { ProjectAccess } from "../lib/history-api";
import {
  attachSessionProject,
  detachSessionProject,
  setSessionProjectAccess,
} from "../lib/session-projects-api";
import { useSessionProjectsStore } from "../stores/session-projects-store";

/** The live ACP session id the composer sends to; `null` before it binds. */
export const SessionProjectsContext = createContext<string | null>(null);

export function useComposerSessionId(): string | null {
  return useContext(SessionProjectsContext);
}

/**
 * Change an attached project's access and say when it takes effect. A grant
 * the agent's sandbox cannot take mid-session (an ACP agent) is kept and
 * applied when the session is next resumed; the toast says so rather than
 * letting the user believe the agent can already write there.
 */
export async function changeProjectAccess(
  sessionId: string,
  path: string,
  access: ProjectAccess,
): Promise<{ resumeOnly: boolean }> {
  try {
    const change = await setSessionProjectAccess(sessionId, path, access);
    useSessionProjectsStore.getState().actions.replace(sessionId, change.projects);
    if (change.changed && access === "read_write" && !change.appliedLive) {
      toast.message("Write access saved", { description: RESUME_HINT });
    }
    return { resumeOnly: change.changed && !change.appliedLive };
  } catch (err) {
    toast.error("Could not change the project's access", { description: String(err) });
    return { resumeOnly: false };
  }
}

/** What a change the agent takes only on resume (an ACP agent) says. */
export const RESUME_HINT = "This agent picks it up when the session is resumed.";

/**
 * Attach the folder at `path` to the session — read-only — and say when the
 * agent sees it. The backend validates the folder (no home folder, system or
 * settings folders); its refusal is shown as it words it. Resolves whether
 * it was attached, and whether only a resume will hand it to the agent.
 */
export async function attachProjectToSession(
  sessionId: string,
  path: string,
  displayName?: string,
): Promise<{ attached: boolean; resumeOnly: boolean }> {
  try {
    const change = await attachSessionProject(sessionId, path, { displayName, source: "mention" });
    useSessionProjectsStore.getState().actions.replace(sessionId, change.projects);
    const resumeOnly = change.changed && !change.appliedLive;
    if (resumeOnly) toast.message("Project attached", { description: RESUME_HINT });
    return { attached: true, resumeOnly };
  } catch (err) {
    toast.error("Could not attach that folder", { description: errorText(err) });
    return { attached: false, resumeOnly: false };
  }
}

/** Detach the project at `path` from the session. */
export async function detachProjectFromSession(
  sessionId: string,
  path: string,
): Promise<{ resumeOnly: boolean }> {
  try {
    const change = await detachSessionProject(sessionId, path);
    useSessionProjectsStore.getState().actions.replace(sessionId, change.projects);
    const resumeOnly = change.changed && !change.appliedLive;
    if (resumeOnly) toast.message("Project detached", { description: RESUME_HINT });
    return { resumeOnly };
  } catch (err) {
    toast.error("Could not detach the project", { description: errorText(err) });
    return { resumeOnly: false };
  }
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}
