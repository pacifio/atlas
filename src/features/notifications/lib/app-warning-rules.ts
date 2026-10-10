/**
 * App warning rules — pure, explicit state in / state out, no store or Tauri
 * imports (like `agent-warning-rules.ts`). Each `evaluateX` decides WHEN a
 * warning-tier notification fires; each `decideX` gives it copy, a target and
 * channels through `decideNotification`.
 *
 *  - Auto-fetch: after `AUTOFETCH_FAIL_THRESHOLD` consecutive failures for a
 *    project, once — then quiet until a fetch succeeds (which re-arms it).
 *  - Behind remote: when an auto-fetch moves the branch's behind-count from 0
 *    to > 0, once per distinct remote head. The first observation per project
 *    only seeds the count (launching already behind is not a transition).
 *    When the count returns to 0 the warning it raised is resolved.
 *  - config.toml: once per distinct error text; a clean load re-arms it.
 *  - Agent update: every failure speaks (the caller numbers them).
 *
 * Auto-fetch and agent-update failures offer Retry beside Open.
 */
import { OPEN_ACTION_ID, type NotificationAction } from "./catalog";
import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationEvent,
  type NotificationPrefs,
} from "./decide";
import { trimError } from "./outcome-notifier-rules";

export const AUTOFETCH_FAIL_THRESHOLD = 3;

// --- Auto-fetch failures --------------------------------------------------

export interface AutoFetchWarnState {
  /** Consecutive failed attempts since the last success. */
  failures: number;
  /** A warning for the current failure run has fired. */
  warned: boolean;
  /** Failure runs that warned so far; part of the dedupe key. */
  episode: number;
}

export const INITIAL_AUTOFETCH_STATE: AutoFetchWarnState = {
  failures: 0,
  warned: false,
  episode: 0,
};

export interface AutoFetchWarning {
  episode: number;
  failures: number;
  error: string;
}

/** One auto-fetch outcome for one project: `error` is null on success.
 *  `resolved` is the episode that just ended (a success after a warning). */
export function evaluateAutoFetch(
  state: AutoFetchWarnState,
  error: string | null,
): { state: AutoFetchWarnState; warning: AutoFetchWarning | null; resolved: number | null } {
  if (error === null) {
    if (state.failures === 0 && !state.warned) return { state, warning: null, resolved: null };
    return {
      state: { ...state, failures: 0, warned: false },
      warning: null,
      resolved: state.warned ? state.episode : null,
    };
  }
  const failures = state.failures + 1;
  if (failures < AUTOFETCH_FAIL_THRESHOLD || state.warned) {
    return { state: { ...state, failures }, warning: null, resolved: null };
  }
  const episode = state.episode + 1;
  return {
    state: { failures, warned: true, episode },
    warning: { episode, failures, error },
    resolved: null,
  };
}

// --- Behind the remote ----------------------------------------------------

export interface BehindWarnState {
  /** Behind-count at the last observation; null until the first. */
  behind: number | null;
  /** Remote head the last warning was for (kept, so a head is announced once). */
  notifiedHead: string | null;
  /** Remote head of the warning still showing; null once resolved. */
  liveHead: string | null;
}

export const INITIAL_BEHIND_STATE: BehindWarnState = {
  behind: null,
  notifiedHead: null,
  liveHead: null,
};

export interface BehindWarning {
  behind: number;
  /** Local commits the remote lacks; > 0 means the branch has diverged. */
  ahead: number;
  remoteHead: string;
}

/** `resolved` is the remote head of the warning that just stopped applying:
 *  the branch caught up (behind is back to 0). */
export function evaluateBehind(
  state: BehindWarnState,
  behind: number,
  remoteHead: string,
  ahead = 0,
): { state: BehindWarnState; warning: BehindWarning | null; resolved: string | null } {
  if (!Number.isFinite(behind) || behind < 0) return { state, warning: null, resolved: null };
  const crossed = state.behind === 0 && behind > 0;
  if (crossed && remoteHead !== state.notifiedHead) {
    return {
      state: { behind, notifiedHead: remoteHead, liveHead: remoteHead },
      warning: { behind, ahead: Number.isFinite(ahead) && ahead > 0 ? ahead : 0, remoteHead },
      resolved: null,
    };
  }
  if (behind === 0 && state.liveHead !== null) {
    return {
      state: { ...state, behind, liveHead: null },
      warning: null,
      resolved: state.liveHead,
    };
  }
  return { state: { ...state, behind }, warning: null, resolved: null };
}

// --- config.toml ----------------------------------------------------------

export interface ConfigWarnState {
  /** The error last warned about; null when the file is (or went back to) valid. */
  lastError: string | null;
}

export const INITIAL_CONFIG_STATE: ConfigWarnState = { lastError: null };

/** `error` is the parser's message, or null when the file loaded cleanly. */
export function evaluateConfigError(
  state: ConfigWarnState,
  error: string | null,
): { state: ConfigWarnState; warning: { error: string } | null; resolved: string | null } {
  if (error === null) {
    return state.lastError === null
      ? { state, warning: null, resolved: null }
      : { state: { lastError: null }, warning: null, resolved: state.lastError };
  }
  if (error === state.lastError) return { state, warning: null, resolved: null };
  return { state: { lastError: error }, warning: { error }, resolved: null };
}

/** Short stable id for an error text — the dedupe key of a distinct error. */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The parser's message without its source excerpt: Rust's `toml` errors run
 *  to a code frame (`3 | key = `, `  |     ^`) that reads badly in a toast. */
export function summarizeConfigError(raw: string): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(\d+\s*)?\|/.test(l));
  const text = lines.join(" — ");
  return trimError(text) || "config.toml could not be loaded.";
}

// --- Decisions ------------------------------------------------------------

export interface ProjectRef {
  projectId: string;
  projectName: string;
  /** The active project — the name is only said when it is not. */
  projectActive: boolean;
}

const gitTarget = (p: ProjectRef) =>
  ({ type: "git-panel", projectId: p.projectId, projectName: p.projectName }) as const;

/** Fetches the project now. Registered by `app-warning-notifier.ts`. */
export const RETRY_FETCH_ACTION_ID = "git.retry-fetch";

export function decideAutoFetchFailing(
  p: ProjectRef,
  w: AutoFetchWarning,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const event: NotificationEvent = {
    kind: "git-autofetch-failing",
    title: "Auto-fetch keeps failing",
    body: trimError(w.error) || `${w.failures} fetches in a row have failed.`,
    subtitle: p.projectActive ? undefined : p.projectName,
    target: gitTarget(p),
    dedupeKey: `autofetch:${p.projectId}:${w.episode}`,
    actions: [
      { id: RETRY_FETCH_ACTION_ID, label: "Retry" },
      { id: OPEN_ACTION_ID, label: "Open" },
    ],
  };
  return decideNotification(event, env, prefs);
}

/** Opens the project's git panel on the rebase-or-merge prompt. Registered by
 *  `app-warning-notifier.ts`, which offers it. */
export const CHOOSE_PULL_ACTION_ID = "git.choose-pull";

/** What a plain pull does on a diverged branch, from git config: the
 *  `PullPreference` read from `git_pull_preference`. */
export type DivergedPull = "rebase" | "merge" | "ask";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Behind only: "Pull to catch up", and Open. Diverged: say so, and — only when
 *  git config leaves the choice open — offer the rebase-or-merge prompt
 *  straight from the notification. A saved preference is named instead. */
export function decideBehind(
  p: ProjectRef,
  branch: string | null,
  w: BehindWarning,
  env: NotificationEnv,
  prefs: NotificationPrefs,
  pull: DivergedPull = "ask",
): NotificationDecision | null {
  const name = branch ?? "Branch";
  const diverged = w.ahead > 0;
  const open: NotificationAction = { id: OPEN_ACTION_ID, label: "Open" };
  const event: NotificationEvent = diverged
    ? {
        kind: "git-behind",
        title: `${name} has diverged from its remote`,
        body:
          `${plural(w.ahead, "local commit")} and ${plural(w.behind, "commit")} on the remote. ` +
          (pull === "ask"
            ? "Choose whether to rebase or merge."
            : `Pulling will ${pull}, per your git config.`),
        subtitle: p.projectActive ? undefined : p.projectName,
        target: gitTarget(p),
        dedupeKey: `behind:${p.projectId}:${w.remoteHead}`,
        actions:
          pull === "ask"
            ? [{ id: CHOOSE_PULL_ACTION_ID, label: "Rebase or merge…" }, open]
            : [open],
      }
    : {
        kind: "git-behind",
        title: branch ? `${branch} is behind its remote` : "Branch is behind its remote",
        body: `${plural(w.behind, "new commit")} on the remote. Pull to catch up.`,
        subtitle: p.projectActive ? undefined : p.projectName,
        target: gitTarget(p),
        dedupeKey: `behind:${p.projectId}:${w.remoteHead}`,
      };
  return decideNotification(event, env, prefs);
}

export function decideConfigError(
  error: string,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const event: NotificationEvent = {
    kind: "config-error",
    title: "config.toml has an error",
    body: `${summarizeConfigError(error)} Atlas is using the last settings that loaded.`,
    target: { type: "config-file" },
    dedupeKey: configErrorDedupeKey(error),
  };
  return decideNotification(event, env, prefs);
}

export const configErrorDedupeKey = (error: string) => `config:${hashText(error)}`;

export interface AgentUpdateFailure {
  pluginId: string;
  /** Display name. */
  name: string;
  version: string;
  error: string | null;
  /** Distinguishes two failures of the same update. */
  seq: number;
}

/** Runs the agent's update again, to the registry's current version.
 *  Registered by `app-warning-notifier.ts`; `args.pluginId` names the agent. */
export const RETRY_AGENT_UPDATE_ACTION_ID = "agents.retry-update";

export function decideAgentUpdateFailed(
  f: AgentUpdateFailure,
  env: NotificationEnv,
  prefs: NotificationPrefs,
): NotificationDecision | null {
  const event: NotificationEvent = {
    kind: "agent-update-failed",
    title: `${f.name} couldn't update to v${f.version}`,
    body: trimError(f.error) || "The install did not complete. It will retry next time.",
    target: { type: "settings", section: "agents" },
    dedupeKey: `agent-update:${f.pluginId}:${f.version}:${f.seq}`,
    actions: [
      { id: RETRY_AGENT_UPDATE_ACTION_ID, label: "Retry", args: { pluginId: f.pluginId } },
      { id: OPEN_ACTION_ID, label: "Open settings" },
    ],
  };
  return decideNotification(event, env, prefs);
}
