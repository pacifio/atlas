/**
 * App warnings on the shared pipeline: auto-fetch that keeps failing, a branch
 * that fell behind its remote, a `config.toml` that does not parse, and an
 * agent update that failed. `startAppWarnings()` (from App.tsx) subscribes to
 * the events; `notifyAgentUpdateFailed` is called by the update flow. The
 * state machines live in `app-warning-rules.ts`; this file holds their state
 * and performs. Nothing here throws.
 */
import { onAutoFetch } from "@/features/git/lib/auto-fetch-events";
import { isDiverged, pullPreference } from "@/features/git/lib/git-pull-api";
import { openGitPanel } from "@/features/git/lib/open-git-panel";
import { useGitStore } from "@/features/git/stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import {
  getConfigInfo,
  onConfigChanged,
  onConfigError,
} from "@/features/settings/lib/atlas-config-api";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import {
  CHOOSE_PULL_ACTION_ID,
  decideAgentUpdateFailed,
  decideAutoFetchFailing,
  decideBehind,
  decideConfigError,
  configErrorDedupeKey,
  evaluateAutoFetch,
  evaluateBehind,
  evaluateConfigError,
  INITIAL_AUTOFETCH_STATE,
  INITIAL_BEHIND_STATE,
  INITIAL_CONFIG_STATE,
  type AutoFetchWarnState,
  type BehindWarnState,
  type ConfigWarnState,
  type ProjectRef,
} from "./app-warning-rules";
import { computeAway, type NotificationEnv } from "./decide";
import { deliverNotification } from "./deliver";
import { registerNotificationAction } from "./notification-actions";
import { prefsFromSettings } from "./prefs";
import { clearResolved } from "./resolve";

function envFor(targetVisible: boolean, projectActive = true): NotificationEnv {
  const windowFocused = isWindowFocused();
  const sinceInputMs = Date.now() - lastInteraction();
  return {
    windowFocused,
    sinceInputMs,
    targetVisible,
    projectActive,
    away: computeAway(windowFocused, sinceInputMs),
  };
}

const prefs = () => prefsFromSettings(useSettingsStore.getState().settings);

function settingsShows(section: string): boolean {
  if (useSettingsNav.getState().shown !== section) return false;
  const layout = useLayoutStore.getState();
  const shown = [layout.activeTabId, ...Object.values(layout.activeByGroup)];
  return shown.some((id) => id && layout.tabs.find((t) => t.id === id)?.type === "settings");
}

function projectFor(path: string): (ProjectRef & { path: string }) | null {
  const ws = useProjectStore.getState();
  const project = ws.projects.find((p) => p.path === path);
  if (!project) return null;
  return {
    path,
    projectId: project.id,
    projectName: project.name,
    projectActive: project.id === ws.activeProjectId,
  };
}

function gitPanelShowing(p: ProjectRef): boolean {
  const rp = useLayoutStore.getState().rightPanel;
  return (
    p.projectActive && rp.visible && rp.mode === "source-control" && rp.activeSection === "changes"
  );
}

// --- Git ------------------------------------------------------------------

const autoFetchState = new Map<string, AutoFetchWarnState>();
const behindState = new Map<string, BehindWarnState>();

// "Rebase or merge…" on a diverged-branch notification: bring the project's
// git panel up with the same prompt its Pull button opens — if the branch is
// still diverged when pressed (a pull elsewhere may have settled it).
registerNotificationAction(
  CHOOSE_PULL_ACTION_ID,
  async ({ target }) => {
    if (target.type !== "git-panel") return;
    await openGitPanel(target.projectId);
    useGitStore.getState().actions.showPullChoice({ kind: "diverged" });
  },
  {
    stillApplies: ({ target }) => {
      if (target.type !== "git-panel") return false;
      const path = useProjectStore.getState().projects.find((p) => p.id === target.projectId)?.path;
      return path ? isDiverged(path) : false;
    },
  },
);

function onAutoFetchStatus(status: {
  project: string;
  lastError: string | null;
  behind?: number | null;
  ahead?: number | null;
  remoteHead?: string | null;
}): void {
  try {
    const p = projectFor(status.project);
    if (!p) return;

    const fetched = evaluateAutoFetch(
      autoFetchState.get(p.path) ?? INITIAL_AUTOFETCH_STATE,
      status.lastError,
    );
    autoFetchState.set(p.path, fetched.state);
    if (fetched.warning) {
      const d = decideAutoFetchFailing(
        p,
        fetched.warning,
        envFor(gitPanelShowing(p), p.projectActive),
        prefs(),
      );
      if (d) deliverNotification(d);
    }
    if (fetched.resolved !== null) {
      clearResolved({
        kind: "git-autofetch-failing",
        target: { type: "git-panel", projectId: p.projectId, projectName: p.projectName },
        dedupeKey: `autofetch:${p.projectId}:${fetched.resolved}`,
        markRead: [{ kind: "git-autofetch-failing" }],
      });
    }

    // Only a successful automatic fetch carries a behind-count.
    if (typeof status.behind === "number" && status.remoteHead) {
      const behind = evaluateBehind(
        behindState.get(p.path) ?? INITIAL_BEHIND_STATE,
        status.behind,
        status.remoteHead,
        status.ahead ?? 0,
      );
      behindState.set(p.path, behind.state);
      if (behind.warning) {
        const git = useGitStore.getState();
        const branch = git.repoPath === p.path ? git.branch : null;
        const warning = behind.warning;
        // Diverged: what a plain pull does depends on git config, so read it
        // before choosing the copy and whether to offer the choice.
        const pull = warning.ahead > 0 ? pullPreference(p.path) : Promise.resolve("ask" as const);
        void pull
          .catch(() => "ask" as const)
          .then((preference) => {
            const d = decideBehind(
              p,
              branch,
              warning,
              envFor(gitPanelShowing(p), p.projectActive),
              prefs(),
              preference,
            );
            if (d) deliverNotification(d);
          });
      }
      if (behind.resolved !== null) {
        // Caught up: the "behind its remote" warning no longer applies.
        clearResolved({
          kind: "git-behind",
          target: { type: "git-panel", projectId: p.projectId, projectName: p.projectName },
          dedupeKey: `behind:${p.projectId}:${behind.resolved}`,
          markRead: [{ kind: "git-behind", projectId: p.projectId }],
        });
      }
    }
  } catch (err) {
    console.warn("auto-fetch warning failed:", err);
  }
}

// --- config.toml ----------------------------------------------------------

let configState: ConfigWarnState = INITIAL_CONFIG_STATE;

/** `error` is the parser's message; null when the file is valid. */
function noteConfig(error: string | null): void {
  try {
    const r = evaluateConfigError(configState, error);
    configState = r.state;
    if (r.warning) {
      const d = decideConfigError(r.warning.error, envFor(false), prefs());
      if (d) deliverNotification(d);
    }
    if (r.resolved !== null) {
      clearResolved({
        kind: "config-error",
        target: { type: "config-file" },
        dedupeKey: configErrorDedupeKey(r.resolved),
        markRead: [{ kind: "config-error" }],
      });
    }
  } catch (err) {
    console.warn("config warning failed:", err);
  }
}

// --- Agent updates --------------------------------------------------------

let updateSeq = 0;

/** An agent update failed (background install or the Update button). */
export function notifyAgentUpdateFailed(f: {
  pluginId: string;
  name: string;
  version: string;
  error: string | null;
}): void {
  try {
    const d = decideAgentUpdateFailed(
      { ...f, seq: ++updateSeq },
      envFor(settingsShows("agents")),
      prefs(),
    );
    if (d) deliverNotification(d);
  } catch (err) {
    console.warn("agent update notification failed:", err);
  }
}

let started = false;

/** Subscribe to the app-warning sources once. Returns an unsubscribe. */
export function startAppWarnings(): () => void {
  if (started) return () => {};
  started = true;
  const offs = [
    onAutoFetch(onAutoFetchStatus),
    onConfigError(noteConfig),
    // A valid reload re-arms the config warning.
    onConfigChanged(() => noteConfig(null)),
  ];
  // A config that failed to load at startup is reported once, here: Rust only
  // emits `atlas:config-error` for later reloads.
  void getConfigInfo()
    .then((info) => {
      const status = info?.status;
      if (status && status.status !== "ok") noteConfig(status.error);
    })
    .catch(() => {});
  return () => {
    started = false;
    for (const off of offs) void off.then((f) => f());
  };
}
