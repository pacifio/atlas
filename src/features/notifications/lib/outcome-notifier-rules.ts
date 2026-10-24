/**
 * Outcome rules for downloads and git remote operations — pure. Each
 * `decideX` classifies one finished thing into a catalog kind and runs it
 * through `decideNotification`; `null` is silence.
 *
 *  - update ready: once per version (`shouldNotifyUpdate`);
 *  - model download: finished and failed both speak (the channel rules decide
 *    where — the Settings view showing the model keeps the toast quiet);
 *  - git push / pull / fetch: a failure always speaks; a success only after a
 *    long wait (`GIT_SUCCESS_MIN_MS`) and when the user is away or not looking
 *    at that project's git panel. Background auto-fetch never reaches here.
 */
import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationEvent,
  type NotificationPrefs,
} from "./decide";

/** A git success shorter than this is just the button spinner stopping. */
export const GIT_SUCCESS_MIN_MS = 10_000;

const ERROR_MAX = 160;

/** The update prompt shows once per version; `last` is what was announced before. */
export const shouldNotifyUpdate = (last: string | null, version: string): boolean =>
  !!version && last !== version;

export function decideUpdateReady(
  version: string,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const event: NotificationEvent = {
    kind: "app-update-ready",
    title: version ? `Atlas ${version} is ready` : "An Atlas update is ready",
    body: "Restart to finish updating.",
    target: { type: "app-update" },
    dedupeKey: `update:${version}`,
  };
  return decideNotification(event, env, prefs);
}

export interface ModelDownloadResult {
  id: string;
  /** Display name; the id when the catalog does not know it. */
  name: string;
  success: boolean;
  error: string | null;
  /** Distinguishes two downloads of the same model. */
  seq: number;
}

export function decideModelDownload(
  r: ModelDownloadResult,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const event: NotificationEvent = r.success
    ? {
        kind: "model-download-done",
        title: `${r.name} downloaded`,
        body: "The model is ready to use.",
        target: { type: "settings", section: "memory" },
        dedupeKey: `model:${r.id}:${r.seq}`,
      }
    : {
        kind: "model-download-failed",
        title: `${r.name} download failed`,
        body: trimError(r.error) || "The download did not complete.",
        target: { type: "settings", section: "memory" },
        dedupeKey: `model:${r.id}:${r.seq}`,
      };
  return decideNotification(event, env, prefs);
}

export type GitRemoteOp = "fetch" | "pull" | "push" | "publish";

const OP_LABEL: Record<GitRemoteOp, string> = {
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
  publish: "Publish",
};

export interface GitOpResult {
  op: GitRemoteOp;
  projectId: string;
  projectName: string;
  /** The project is the active one — the name is only said when it is not. */
  projectActive: boolean;
  durationMs: number;
  /** Null on success; the raw error text otherwise. */
  error: string | null;
  seq: number;
}

/** First line of a (possibly multi-line) git error, capped. */
export function trimError(raw: string | null | undefined): string {
  const first = (raw ?? "").split("\n").find((l) => l.trim()) ?? "";
  const line = first.trim();
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export function decideGitOp(
  r: GitOpResult,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const failed = r.error !== null;
  if (!failed && (r.durationMs < GIT_SUCCESS_MIN_MS || !(env.away || !env.targetVisible))) {
    return null;
  }
  const label = OP_LABEL[r.op];
  const event: NotificationEvent = {
    kind: failed ? "git-op-failed" : "git-op-done",
    title: failed ? `${label} failed` : `${label} finished`,
    body: failed
      ? trimError(r.error) || "Git reported an error."
      : `Took ${seconds(r.durationMs)}.`,
    subtitle: r.projectActive ? undefined : r.projectName,
    target: { type: "git-panel", projectId: r.projectId, projectName: r.projectName },
    dedupeKey: `git:${r.projectId}:${r.op}:${r.seq}`,
  };
  return decideNotification(event, env, prefs);
}
