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
import { applyUiScale } from "@/features/settings/lib/ui-scale";
import { applyEditorTheme } from "@/features/editor/themes/apply-editor-theme";
import { applyAtlasTheme } from "@/features/theme/apply-atlas-theme";
import {
  updateSettings as updateAtlasConfig,
  resetConfig as resetAtlasConfig,
  onConfigChanged,
  onConfigError,
  type ConfigStatus,
  type SettingsPatch,
} from "@/features/settings/lib/atlas-config-api";
import { commitConfigPatch, setConfigGeneration } from "@/features/settings/lib/config-write";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import type { KeymapWire } from "@/features/keybindings/lib/keymap-api";

// Re-exported because most of the app reaches for `AppSettings` through the
// store it reads settings from; the definition itself belongs to the settings
// feature (see `app-settings.ts`).
export type { AppSettings };

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
  /** Sourced from `config.toml`, not `state.json` (issue #64) — folded into
   *  this same bootstrap response for one round trip, but written back
   *  through `update_atlas_settings`, never `save_app_state`. Optional only
   *  because the bootstrap-failure fallback path constructs a payload by
   *  hand without it; `hydrate` merges over `DEFAULT_SETTINGS` regardless. */
  settings?: AppSettings;
  /** The `[keymap]` section of the same file, hydrated into the keybindings
   *  store on the way through — see `keybindings-store.ts`. Optional for the
   *  same reason `settings` is. */
  keymap?: KeymapWire;
  /** Whether the first-run keymap picker has been answered. Rust-owned state
   *  (`state.json`), so it rides in here rather than in `config.toml`. */
  keymapOnboardingSeen?: boolean;
  /** Optimistic-concurrency counter for both `update_atlas_settings` and
   *  `update_atlas_keymap` — see `config-write.ts`. */
  configGeneration?: number;
  /** Whether `config.toml` actually loaded. Anything other than `ok` means
   *  `settings` above are Atlas's defaults, not the user's. Optional only
   *  because the bootstrap-failure fallback path builds a payload by hand. */
  configStatus?: ConfigStatus;
  version: number;
}

interface ProjectState {
  currentProject: Project | null;
  recentProjects: RecentProject[];
  settings: AppSettings;
  /** Set when `config.toml` is currently malformed (external edit or a
   *  rejected write) — `settings` still holds the last valid snapshot.
   *  `null` when there's nothing to report. Settings UI surfaces this. */
  configError: string | null;
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
    /** Applies + persists a settings change through `config.toml`
     *  (`update_atlas_settings`) — see `atlas-config-api.ts`. Optimistic:
     *  the store updates immediately, then reconciles with whatever Rust
     *  actually committed (a validation failure or a generation conflict
     *  rolls the optimistic change back to the last-known-good snapshot). */
    updateSettings: (partial: Partial<AppSettings>) => void;
    /** Dismiss the current `configError` banner without touching the file. */
    clearConfigError: () => void;
    /** "Recreate defaults" — the one action allowed to overwrite a malformed
     *  `config.toml` (Rust backs the old file up first). Owns the state write
     *  AND the resulting side effects, which is why the Settings panel calls
     *  this rather than reaching into `setState` itself. Rejects with the
     *  underlying error so the caller can toast it. */
    resetConfig: () => Promise<void>;
    /** One-shot hydration from Rust. Called once on app boot. */
    hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => void;
  };
}

/** The `AppStatePatch` shape `save_app_state` actually accepts — settings are
 *  no longer part of it (issue #64: they persist through `config.toml` /
 *  `update_atlas_settings` instead, see `updateSettings` below). */
interface AppStatePatchWire {
  currentProject: null;
  recentProjects: RecentProject[];
  workspaces: Workspace[];
  groups: WorkspaceGroup[];
  activeWorkspaceId: string | null;
  organisations: Organisation[];
  activeOrganisationId: string | null;
}

// Debounced persistence: the Rust `save_app_state` command takes the
// workspaces/recents/orgs slice of `AppState`. Both `useProjectStore`
// (recents) and `useWorkspaceStore` (workspaces/groups/activeWorkspaceId)
// contribute to it, so the save reads from both stores at flush time.
// Coalesced to ~500ms.
/** Build the `AppStatePatch` payload from every contributing store. Shared by
 *  the debounced + immediate save paths so they never drift. */
function buildAppStatePayload(): AppStatePatchWire {
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

/** Re-apply every settings-driven side effect whose value actually changed
 *  between `previous` and `next`. Shared by `updateSettings` (both the
 *  optimistic apply and the reconciled result), `hydrate`, and the
 *  `atlas:config-changed` listener below — one path so a hot-reloaded
 *  external edit re-applies UI scale/theme/explorer state exactly like a
 *  UI-driven change does. */
function applySettingsSideEffects(next: AppSettings, previous: AppSettings): void {
  // Toggling hidden-files visibility must re-apply the explorer's dotfile
  // filter immediately. `refresh()` reconciles the root and every expanded
  // subtree, so the user's expansion state survives.
  if (next.showHiddenFiles !== previous.showHiddenFiles) {
    void useExplorerStore.getState().actions.refresh();
  }
  if (next.uiScale !== previous.uiScale) applyUiScale(next.uiScale);
  if (next.codeEditorTheme !== previous.codeEditorTheme) applyEditorTheme(next.codeEditorTheme);
  if (next.atlasTheme !== previous.atlasTheme) applyAtlasTheme(next.atlasTheme);
}

/** Turn a boot-time `ConfigStatus` into the banner string, or `null` when the
 *  file loaded cleanly. */
function configErrorFrom(status: ConfigStatus | undefined): string | null {
  if (!status || status.status === "ok") return null;
  return status.status === "usingDefaults"
    ? `config.toml could not be loaded, so Atlas is running on default settings — your saved preferences are not applied. ${status.error}`
    : `config.toml is currently invalid; Atlas is running on the last settings that loaded cleanly. ${status.error}`;
}

export const useProjectStore = createSelectors(
  create<ProjectState>()((set, get) => ({
    currentProject: null,
    recentProjects: [],
    settings: DEFAULT_SETTINGS,
    configError: null,
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
        // Optimistic: apply immediately so the control feels instant, then
        // reconcile with whatever `config.toml` actually ends up holding.
        // Rust validates the full candidate and can reject it outright, or —
        // on a stale `configGeneration` — refuse to apply and return a
        // Conflict instead; `commitConfigPatch` owns the adopt-and-retry
        // policy for that, and a conflict here means it gave up.
        const previous = get().settings;
        const optimistic = { ...previous, ...partial };
        set({ settings: optimistic });
        applySettingsSideEffects(optimistic, previous);

        commitConfigPatch((generation) => updateAtlasConfig(partial as SettingsPatch, generation))
          .then((outcome) => {
            if (outcome.kind === "conflict") {
              console.warn(
                "updateSettings: still conflicting after adopting the latest generation",
              );
            }
            set({
              settings: outcome.settings,
              configError:
                outcome.kind === "conflict"
                  ? "Settings change conflicted with a concurrent edit — please try again."
                  : null,
            });
            applySettingsSideEffects(outcome.settings, optimistic);
          })
          .catch((e) => {
            console.warn("update_atlas_settings failed:", e);
            set({ settings: previous, configError: String(e) });
            applySettingsSideEffects(previous, optimistic);
          });
      },
      clearConfigError: () => set({ configError: null }),
      resetConfig: async () => {
        const previous = get().settings;
        const snapshot = await resetAtlasConfig();
        setConfigGeneration(snapshot.generation);
        set({ settings: snapshot.settings, configError: null });
        useKeybindingsStore.getState().actions.hydrate(snapshot.keymap);
        applySettingsSideEffects(snapshot.settings, previous);
      },
      hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => {
        // Merge with defaults so an older/mid-migration response missing a
        // brand-new key gets the modern default rather than `undefined` —
        // belt-and-suspenders on top of Rust's own field-level defaulting.
        const settings: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...payload.settings,
        };
        setConfigGeneration(payload.configGeneration ?? 0);
        if (payload.keymap) useKeybindingsStore.getState().actions.hydrate(payload.keymap);
        useKeybindingsStore
          .getState()
          .actions.hydrateOnboardingSeen(payload.keymapOnboardingSeen ?? false);
        set({
          currentProject: null,
          recentProjects: payload.recentProjects ?? [],
          settings,
          // A `config.toml` that failed to load at startup is the one case the
          // user cannot otherwise notice: every preference silently reads back
          // as an Atlas default (`shareTelemetry` included). Rust computes the
          // status at boot; hard-nulling it here is what kept it off screen.
          configError: configErrorFrom(payload.configStatus),
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

// `config.toml` can change for reasons other than this window's own
// `updateSettings` call: the Settings UI edited it in another window (not
// currently possible — Atlas is single-window — but this is also what fires
// for a `reset_atlas_config`), or an external editor / the
// `atlas-self-configure` skill wrote to it directly. Both land here as a hot
// reload; `applySettingsSideEffects` re-applies exactly the side effects that
// actually changed, same as a UI-driven update.
void onConfigChanged(({ settings, keymap, generation }) => {
  const previous = useProjectStore.getState().settings;
  setConfigGeneration(generation);
  useProjectStore.setState({ settings, configError: null });
  useKeybindingsStore.getState().actions.hydrate(keymap);
  applySettingsSideEffects(settings, previous);
});

// A malformed external edit (or a write Rust rejected) — `settings` is
// unchanged, this is purely "tell the user".
void onConfigError((error) => {
  useProjectStore.setState({ configError: error });
});
