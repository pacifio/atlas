import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useSessionStore } from "./session-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useKnowledgeMetaStore } from "@/features/knowledge/stores/knowledge-meta-store";
import { logEvent } from "@/features/log/lib/log";
import {
  useWorkspaceStore,
  type Workspace,
  type WorkspaceGroup,
} from "@/features/workspaces/stores/workspace-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { Organisation } from "@/features/organisations/types";
import { registerFlush } from "@/features/workspaces/lib/flush-registry";
import { persistHashOf } from "@/features/workspaces/lib/workspace-snapshot";
import { applyUiScale, DEFAULT_SCALE } from "@/features/settings/lib/ui-scale";
import { applyEditorTheme } from "@/features/editor/themes/apply-editor-theme";
import { DEFAULT_EDITOR_THEME_ID } from "@/features/editor/themes/themes";
import { applyAtlasTheme } from "@/features/theme/apply-atlas-theme";
import { DEFAULT_ATLAS_THEME_ID } from "@/features/theme/themes";

interface Project {
  name: string;
  path: string;
}

interface RecentProject {
  name: string;
  path: string;
  lastOpened: string;
}

/**
 * App-wide preferences surfaced in Settings → General. Mirrors
 * `src-tauri/src/state/app_state.rs:AppSettings`. Defaults declared on
 * both sides; if you add a field, default it both places.
 */
export interface AppSettings {
  /** Auto-add `.atlas/` to each opened git project's `.gitignore`. */
  autoAddAtlasGitignore: boolean;
  /** Record Atlas-internal events (sign-in, agent lifecycle, etc.) into
   *  the Logs panel under the `atlas` source. */
  enableAtlasLogs: boolean;
  /** Show dotfiles / dot-directories in the explorer file tree. */
  showHiddenFiles: boolean;
  /** Global interface zoom (1 == 100%). Driven by the ⌘+/⌘-/⌘0 hotkeys;
   *  applied via the native WebView zoom. */
  uiScale: number;
  /** Anonymous product telemetry (PostHog). Default ON (opt-out) — gates both
   *  the Rust emitter and the frontend crash reporter. See
   *  `src/features/telemetry`. */
  shareTelemetry: boolean;
  /** Attribute telemetry to the signed-in Atlas account rather than keeping it
   *  on the anonymous per-device person. Default ON; irrelevant while signed out
   *  or while `shareTelemetry` is off — both gate it. */
  linkTelemetryToAccount: boolean;
  /** Selected on-device embedding model id (== dir name). Managed by the Local
   *  Model Manager; carried here so settings round-trips never clobber it. */
  embeddingModelId: string;
  /** Code-editor color theme id (see src/features/editor/themes). Drives the
   *  CodeMirror editor, the diff viewer and the source-control diff views. */
  codeEditorTheme: string;
  /** Atlas interface-theme id (see src/features/theme/themes). Swaps the whole
   *  dark UI palette — background, panels, text, borders and accent — while
   *  keeping dark-theme primitives. Independent of `codeEditorTheme` (which only
   *  themes code syntax). Default "atlas-black" = original AMOLED look. */
  atlasTheme: string;
  /** Adaptive next-step suggestion chips in the agent chat's per-turn card.
   *  "agent" (default) asks the coding agent to end each reply with a hidden
   *  `<next_steps>` block (uses the live session context, no BYOK); "off"
   *  disables it. (Legacy "parse"/"llm" values are treated as enabled.) */
  adaptiveSuggestions: "off" | "agent";
  /** Inline Git blame in the code editor — dim author/age/summary annotation
   *  trailing the active line. Off = the CodeMirror extension isn't loaded. */
  gitBlameInline: boolean;
  /** Auto-update master switch. ON (default) → every startup checks PostHog
   *  remote config and prompts when a newer signed DMG is available. */
  autoUpdate: boolean;
  /** A version the user chose to "Ignore" in the update prompt; the startup
   *  check won't re-prompt for exactly this version. */
  updaterIgnoredVersion: string | null;
  /** Chat composer send gesture. true (default) = Enter sends, Shift+Enter
   *  inserts a newline (Slack/Discord/ChatGPT convention). false = only
   *  Cmd/Ctrl+Enter sends, bare Enter always inserts a newline (the old
   *  default). Cmd/Ctrl+Enter always sends regardless of this setting. */
  enterToSend: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  autoAddAtlasGitignore: true,
  enableAtlasLogs: true,
  showHiddenFiles: true,
  uiScale: DEFAULT_SCALE,
  shareTelemetry: true,
  linkTelemetryToAccount: true,
  embeddingModelId: "all-MiniLM-L6-v2",
  codeEditorTheme: DEFAULT_EDITOR_THEME_ID,
  atlasTheme: DEFAULT_ATLAS_THEME_ID,
  adaptiveSuggestions: "agent",
  gitBlameInline: true,
  autoUpdate: true,
  updaterIgnoredVersion: null,
  enterToSend: true,
};

/**
 * Wire shape returned by the Rust `bootstrap_app_state` command. Mirrors
 * `src-tauri/src/state/app_state.rs:AppState` field-for-field.
 *
 * `currentProject` is a legacy v1 field — Rust migrates it into `workspaces`
 * on load, so it arrives `null` here in practice. The multi-workspace fields
 * are the source of truth.
 */
export interface AppStateWire {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  workspaces?: Workspace[];
  groups?: WorkspaceGroup[];
  activeWorkspaceId?: string | null;
  /** The Organisation layer above workspaces (v3). */
  organisations?: Organisation[];
  activeOrganisationId?: string | null;
  settings?: AppSettings;
  version: number;
}

interface ProjectState {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  settings: AppSettings;
  /** True until the Rust-side bootstrap returns. UI gates on this to keep
   *  the boot skeleton up rather than flashing an empty WelcomeScreen. */
  hydrated: boolean;
  actions: {
    /** Public entry point used across the app (welcome screen, titlebar,
     *  command palette, CLI). Adds-or-focuses a workspace for `path`. */
    openProject: (path: string) => Promise<void>;
    /** Point the store at a workspace's project (or clear with `null`).
     *  Called by the workspace switch coordinator — does NOT run the
     *  downstream loaders (that's `loadProjectStores`). */
    setActiveProject: (project: Project | null) => void;
    removeRecent: (path: string) => void;
    clearRecents: () => void;
    updateSettings: (partial: Partial<AppSettings>) => void;
    /** One-shot hydration from Rust. Called once on app boot. */
    hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => void;
  };
}

// Debounced persistence: the Rust `save_app_state` command takes the full
// `AppState` payload. Both `useProjectStore` (recents/settings) and
// `useWorkspaceStore` (workspaces/groups/activeWorkspaceId) contribute to it,
// so the save reads from both stores at flush time. Coalesced to ~500ms.
/** Build the full `AppState` payload from every contributing store. Shared by
 *  the debounced + immediate save paths so they never drift. */
function buildAppStatePayload(): AppStateWire {
  const project = useProjectStore.getState();
  const ws = useWorkspaceStore.getState();
  const org = useOrgStore.getState();
  return {
    currentProject: null,
    recentProjects: project.recentProjects,
    workspaces: ws.workspaces,
    groups: ws.groups,
    activeWorkspaceId: ws.activeWorkspaceId,
    organisations: org.organisations,
    activeOrganisationId: org.activeOrganisationId,
    settings: project.settings,
    version: 3,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleAppStateSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_app_state", { payload: buildAppStatePayload() }).catch((e) =>
      console.warn("save_app_state failed:", e),
    );
  }, 500);
}

/** Flush the pending app-state save immediately (used by the switch/quit
 *  flush coordinator) so workspace list + active id are durable. */
export async function flushAppStateSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await invoke("save_app_state", { payload: buildAppStatePayload() }).catch((e) =>
    console.warn("flushAppStateSave failed:", e),
  );
}

// The workspace list + active id must be durable on quit/close, so register it
// with the flush coordinator. On a SWITCH the write is fired without being
// awaited: it held a full IPC + disk round-trip on the critical path of every
// switch, for a payload that (a) is about to change again the moment the
// switch commits, and (b) is re-saved by the switch's own
// `scheduleAppStateSave()` 500ms later. Losing it in a crash costs workspace
// -list metadata only — never user content, which is what the awaited
// KB/editor flushes protect.
registerFlush("app-state", (ctx) => {
  if (ctx.reason === "switch") {
    void flushAppStateSave();
    return Promise.resolve();
  }
  return flushAppStateSave();
});

// Dedup gate: the persist hash last written to disk per workspace. If the
// workspace's snapshot hash is unchanged since the last write, we skip the
// editor-state disk write entirely (the user's "don't re-write the cache when
// the snapshot is identical").
const lastPersistedHash = new Map<string, string>();

// Editor tabs / split layout for a workspace. `ctx.path` is the OUTGOING
// project path (passed explicitly so the write targets the right project even
// after `currentProject` has swapped); falls back to the live current project
// for non-switch flushes (e.g. app quit).
registerFlush("editor-state", async (ctx) => {
  const path = ctx.path ?? useProjectStore.getState().currentProject?.path;
  if (!path) return;

  // Skip the disk write when nothing the user cares about changed.
  if (ctx.workspaceId) {
    const hash = persistHashOf(ctx.workspaceId);
    if (hash && lastPersistedHash.get(ctx.workspaceId) === hash) {
      return; // identical snapshot — no write
    }
    if (hash) lastPersistedHash.set(ctx.workspaceId, hash);
  }
  await useLayoutStore.getState().actions.flushEditorState(path);
});

/**
 * Fire-and-forget: ensure the project's `.gitignore` contains `.atlas/`,
 * gated on the user setting. Idempotent + silent — failures are logged
 * but never bubble up to the UI.
 */
function maybeEnsureAtlasGitignore(path: string, settings: AppSettings): void {
  if (!settings.autoAddAtlasGitignore) return;
  invoke("ensure_atlas_gitignore", { projectPath: path }).catch((e) =>
    console.warn("ensure_atlas_gitignore failed:", e),
  );
}

/**
 * Load every downstream store for `path` in parallel. Shared by workspace
 * switch + boot hydration. Each loader renders its own loading state, so this
 * runs on Tauri's runtime without blocking the JS main thread.
 *
 * `loadLog` is intentionally NOT fired — the git-store's `log` field is unused
 * (git-graph-panel has its own useQuery) and `git log --all` is the slowest
 * of the bunch.
 */
export async function loadProjectStores(path: string): Promise<void> {
  // Panel-data loaders run UNAWAITED: each renders its own loading state, and
  // nothing after this function needs their results — awaiting them only held
  // the cold switch's settle (and its seed snapshot) hostage to the slowest
  // IPC of the batch. The awaited pair below is the actual critical path:
  // tabs/splits (first paint of the center panel) and the KB meta bind (cheap;
  // the @-/~ mention picker shows raw note-ids without it).
  void useExplorerStore
    .getState()
    .actions.openFolder(path)
    .catch((e) => console.error("Explorer failed:", e));
  void useGitStore
    .getState()
    .actions.loadStatus(path)
    .catch((e) => console.error("Git failed:", e));
  void useSessionStore
    .getState()
    .actions.loadSession(path)
    .catch((e) => console.error("Session load failed:", e));
  await Promise.all([
    useKnowledgeMetaStore
      .getState()
      .actions.bind(path)
      .catch((e) => console.error("Knowledge bind failed:", e)),
    useLayoutStore
      .getState()
      .actions.loadEditorState(path)
      .catch((e) => console.error("Editor state load failed:", e)),
  ]);

  // Load the full KB entries OFF the switch critical path. This is the single
  // biggest post-switch main-thread spike (up to ~1.2s on large vaults) and it
  // isn't needed for first paint — Knowledge isn't the landing tab, and
  // `KnowledgePanel` reloads entries on its own mount. Deferring to idle keeps
  // its setState from colliding with (and congesting) rapid workspace switches,
  // while still warming the @-/~ mention cache shortly after open. Fire-and-
  // forget; a stale project is harmless (entries are keyed by path).
  const warmEntries = () => {
    void useKnowledgeStore
      .getState()
      .actions.loadEntries(path)
      .catch((e) => console.error("Knowledge entries load failed:", e));
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warmEntries, { timeout: 2000 });
  } else {
    setTimeout(warmEntries, 0);
  }
}

export const useProjectStore = createSelectors(
  create<ProjectState>()((set, get) => ({
    currentProject: null,
    recentProjects: [],
    settings: DEFAULT_SETTINGS,
    hydrated: false,
    actions: {
      openProject: async (path: string) => {
        // The workspace store is now the single entry point for "open a
        // project": it dedupes by path (focus-existing) and drives the
        // flush/restore switch. Everything that used to call openProject
        // keeps working unchanged.
        await useWorkspaceStore.getState().actions.addWorkspace(path);
      },

      setActiveProject: (project: Project | null) => {
        if (!project) {
          set({ currentProject: null });
          return;
        }
        const { name, path } = project;
        set((s) => ({
          currentProject: { name, path },
          recentProjects: [
            { name, path, lastOpened: new Date().toISOString() },
            ...s.recentProjects.filter((r) => r.path !== path),
          ].slice(0, 20),
        }));

        // Idempotent + setting-gated. Safe to fire on every switch.
        maybeEnsureAtlasGitignore(path, get().settings);
        // Grant the asset protocol access to this project's tree so the media
        // viewer can serve its files. Scope only widens across workspaces.
        invoke("asset_allow_dir", { path }).catch(() => {});

        logEvent({
          source: "project",
          kind: "open",
          summary: name,
          projectPath: path,
          projectName: name,
          payload: { path },
        });
        logEvent({
          source: "atlas",
          kind: "project-open",
          summary: `Opened project: ${name}`,
          status: "success",
          projectPath: path,
          projectName: name,
          payload: { path },
        });
      },

      removeRecent: (path: string) => {
        set((s) => ({
          recentProjects: s.recentProjects.filter((r) => r.path !== path),
        }));
        scheduleAppStateSave();
      },
      clearRecents: () => {
        set({ recentProjects: [] });
        scheduleAppStateSave();
      },
      updateSettings: (partial: Partial<AppSettings>) => {
        set((s) => ({ settings: { ...s.settings, ...partial } }));
        scheduleAppStateSave();
        // Toggling hidden-files visibility must re-apply the explorer's
        // dotfile filter immediately. `refresh()` reconciles the root and
        // every expanded subtree, so the user's expansion state survives.
        if (partial.showHiddenFiles !== undefined) {
          void useExplorerStore.getState().actions.refresh();
        }
        if (partial.uiScale !== undefined) applyUiScale(partial.uiScale);
        if (partial.codeEditorTheme !== undefined) applyEditorTheme(partial.codeEditorTheme);
        if (partial.atlasTheme !== undefined) applyAtlasTheme(partial.atlasTheme);
      },
      hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => {
        // Merge with defaults so older state.json files (written before a new
        // setting existed) get the modern default rather than `undefined`.
        const settings: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...payload.settings,
        };
        set({
          currentProject: null,
          recentProjects: payload.recentProjects ?? [],
          settings,
          hydrated: true,
        });

        // Re-apply the persisted interface zoom (needs the Tauri WebView API,
        // so it can only run here, not in the pre-mount boot path).
        applyUiScale(settings.uiScale);
        // Re-apply the persisted code-editor theme (writes CSS custom
        // properties consumed by the editor/diff surfaces).
        applyEditorTheme(settings.codeEditorTheme);
        // Re-apply the persisted Atlas interface theme (writes the palette CSS
        // custom properties that re-skin the whole dark UI).
        applyAtlasTheme(settings.atlasTheme);

        // Hand the Organisation layer to the org store FIRST — the workspace
        // sidebar filters by the active org, and new workspaces tag themselves
        // with it. (Rust `migrate()` guarantees a default "Personal" org + an
        // `activeOrganisationId` on any pre-v3 state, so this is always set.)
        useOrgStore.getState().actions.hydrate({
          organisations: payload.organisations ?? [],
          activeOrganisationId: payload.activeOrganisationId ?? null,
        });

        // Hand the multi-workspace fields to the workspace store. We hydrate
        // with `activeWorkspaceId: null` and then `switchTo` the persisted id
        // below, so the switch is a genuine null→id transition that actually
        // runs the loaders (a same-id switch is a no-op by design).
        const workspaces = payload.workspaces ?? [];
        const groups = payload.groups ?? [];
        const activeWorkspaceId = payload.activeWorkspaceId ?? null;
        useWorkspaceStore.getState().actions.hydrate({
          workspaces,
          groups,
          activeWorkspaceId: null,
        });

        // Restore the active workspace, if any. `switchTo` sets
        // `currentProject` (which drives the App-level Rust lifecycle effects)
        // and loads the downstream stores.
        //
        // `skipActiveSwitch` is set when a `atlas <path>` CLI launch is about to
        // open its own workspace: `switchTo` no-ops while another switch is in
        // flight (the `switching` guard), so auto-switching here would swallow
        // the CLI switch and strand the user on the persisted workspace. The
        // caller switches to the CLI project instead.
        const active = activeWorkspaceId && workspaces.find((w) => w.id === activeWorkspaceId);
        if (active && !opts?.skipActiveSwitch) {
          maybeEnsureAtlasGitignore(active.path, settings);
          void useWorkspaceStore.getState().actions.switchTo(active.id);
        }
      },
    },
  })),
);
