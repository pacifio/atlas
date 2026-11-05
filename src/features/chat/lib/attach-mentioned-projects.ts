/**
 * Mentioning a project attaches it to the session.
 *
 * An `@workspace:` (project) or `@repo:` chip used to be a one-message hint:
 * the path rode in the prompt and nothing remembered it. Now a send attaches
 * every project it mentions to the session — read-only unless the user
 * already granted more — and the mention goes to `compose_prompt` carrying
 * that access, so the agent's context block says what it may do there.
 *
 * Attaching is idempotent (a path already attached keeps its access), so this
 * runs on every send rather than tracking which chips are new. A folder the
 * backend refuses (the home folder, a system folder) is still mentioned, just
 * not attached; the refusal is the caller's to show.
 */

import type { MentionData } from "./mentions";
import type { AttachedProject } from "./history-api";
import { attachSessionProject } from "./session-projects-api";

/** A mention that names a project folder. */
export type ProjectMention = Extract<MentionData, { kind: "workspace" | "repo" }>;

export function isProjectMention(m: MentionData): m is ProjectMention {
  return m.kind === "workspace" || m.kind === "repo";
}

export interface AttachedMentions {
  /** The mentions, a project mention carrying `access` when attached. */
  mentions: MentionData[];
  /** The session's attached projects after the last attach, if any ran. */
  projects: AttachedProject[] | null;
  /** Folders that could not be attached, with the backend's reason. */
  refused: { displayName: string; reason: string }[];
}

/**
 * Attach every project `mentions` names to `sessionId`, in order, and return
 * the mentions with their access filled in.
 */
export async function attachMentionedProjects(
  sessionId: string,
  mentions: MentionData[],
): Promise<AttachedMentions> {
  const refused: AttachedMentions["refused"] = [];
  let projects: AttachedProject[] | null = null;
  const out: MentionData[] = [];
  for (const m of mentions) {
    if (!isProjectMention(m)) {
      out.push(m);
      continue;
    }
    try {
      const change = await attachSessionProject(sessionId, m.absPath, {
        displayName: m.displayName,
        source: "mention",
      });
      projects = change.projects;
      const attached = matchProject(change.projects, m.absPath);
      out.push(attached ? { ...m, access: attached.access } : m);
    } catch (err) {
      refused.push({ displayName: m.displayName, reason: errorText(err) });
      out.push(m);
    }
  }
  return { mentions: out, projects, refused };
}

/**
 * The attached entry for a mentioned path. The backend stores the canonical
 * path; a trailing slash is the difference a chip commonly carries. A chip
 * through a symlink matches nothing, and its mention goes without an access
 * level — the old wording, never a wrong one.
 */
export function matchProject(
  projects: AttachedProject[],
  absPath: string,
): AttachedProject | undefined {
  const want = absPath.replace(/\/+$/, "");
  return projects.find((p) => p.path === want);
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}
