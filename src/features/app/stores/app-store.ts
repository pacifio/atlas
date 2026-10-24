import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { logEvent } from "@/features/log/lib/log";
import {
  useProjectStore,
  type Project,
  type ProjectGroup,
} from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import {
  fromOrganisationWire,
  toOrganisationWire,
  type OrganisationWire,
} from "@/features/organisations/types";
import { registerFlush } from "@/features/projects/lib/flush-registry";
import { persistHashOf } from "@/features/projects/lib/project-snapshot";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { ConfigStatus } from "@/features/settings/lib/atlas-config-api";
import type { AppSettings } from "@/features/settings/lib/app-settings";

/** Just enough to name the open project: `Project` itself belongs to the
 *  projects feature, and this is only the {name, path} pair the app store
 *  and the persisted recents list carry. */
interface ProjectRef {
  name: string;
  path: string;
}

interface RecentProject {
  name: string;
  path: string;
  lastOpened: string;
  /** The org this was opened under. `null` on entries written before recents
   *  were scoped — `recentsForOrg` attributes those by path. */
  orgId?: string | null;
}

/**
 * Wire shape returned by the Rust `bootstrap_app_state` command. Mirrors
 * `src-tauri/src/state/app_state.rs:AppState` field-for-field.
 *
 * `currentProject` is a legacy v1 field — Rust migrates it into `workspaces`
 * on load, so it arrives `null` here in practice. The multi-project fields
 * are the source of truth.
 *
 * `workspaces` / `activeWorkspaceId` are STORAGE KEYS, not concepts: they are
 * what `state.json` has held since v2, so renaming them would need a data
 * migration and break every existing install. The app calls these projects.
 */
export interface AppStateWire {
  currentProject: ProjectRef | null;
  recentProjects: RecentProject[];
  workspaces?: Project[];
  groups?: ProjectGroup[];
  activeWorkspaceId?: string | null;
  /** The Organisation layer above projects (v3). `OrganisationWire`, not
   *  `Organisation`: the per-org active project is a frozen storage key too
   *  (`activeWorkspaceId`), so it is translated on the way in. */
  organisations?: OrganisationWire[];
  activeOrganisationId?: string | null;
  /** Sourced from `config.toml`, not `state.json` (issue #64) — folded into
   *  this same bootstrap response for one round trip, but written back
   *  through `update_atlas_settings`, never `save_app_state`. Handed straight
   *  to the settings store; optional only because the bootstrap-failure
   *  fallback path constructs a payload by hand without it. */
  settings?: AppSettings;
  /** Optimistic-concurrency counter for `update_atlas_settings` — see
   *  `atlas-config-api.ts`. */
  configGeneration?: number;
  /** Whether `config.toml` actually loaded. Anything other than `ok` means
   *  `settings` above are Atlas's defaults, not the user's. Optional only
   *  because the bootstrap-failure fallback path builds a payload by hand. */
  configStatus?: ConfigStatus;
  version: number;
}

interface AppState {
  currentProject: ProjectRef | null;
  recentProjects: RecentProject[];
  /** True until the Rust-side bootstrap returns. UI gates on this to keep
   *  the boot skeleton up rather than flashing an empty WelcomeScreen. */
  hydrated: boolean;
  actions: {
    /** Public entry point used across the app (welcome screen, titlebar,
     *  command palette, CLI). Adds-or-focuses a project for `path`. */
    openProject: (path: string) => Promise<void>;
    /** Point the store at the switched-to project (or clear with `null`).
     *  Called by the project switch coordinator — does NOT run the
     *  downstream loaders (that's `loadProjectStores`). */
    setActiveProject: (project: ProjectRef | null) => void;
    removeRecent: (path: string) => void;
    clearRecents: () => void;
    /** One-shot hydration from Rust. Called once on app boot. */
    hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => void;
  };
}

/** The `AppStatePatch` shape `save_app_state` actually accepts — settings are
 *  no longer part of it (issue #64: they persist through `config.toml` /
 *  `update_atlas_settings` instead, see the settings store). */
interface AppStatePatchWire {
  currentProject: null;
  recentProjects: RecentProject[];
  /** Storage keys — see `AppStateWire`. The values are projects. */
  workspaces: Project[];
  groups: ProjectGroup[];
  activeWorkspaceId: string | null;
  /** Storage keys again, one level down: each org's last-active project rides
   *  as `activeWorkspaceId`. See `OrganisationWire`. */
  organisations: OrganisationWire[];
  activeOrganisationId: string | null;
}

// Debounced persistence: the Rust `save_app_state` command takes the
// projects/recents/orgs slice of `AppState`. Both `useAppStore`
// (recents) and `useProjectStore` (projects/groups/activeProjectId)
// contribute to it, so the save reads from both stores at flush time.
// Coalesced to ~500ms.
/** Build the `AppStatePatch` payload from every contributing store. Shared by
 *  the debounced + immediate save paths so they never drift. */
function buildAppStatePayload(): AppStatePatchWire {
  const app = useAppStore.getState();
  const ws = useProjectStore.getState();
  const org = useOrgStore.getState();
  return {
    currentProject: null,
    recentProjects: app.recentProjects,
    workspaces: ws.projects,
    groups: ws.groups,
    activeWorkspaceId: ws.activeProjectId,
    organisations: org.organisations.map(toOrganisationWire),
    activeOrganisationId: org.activeOrganisationId,
  };
}

/** Whether the in-memory state is authoritative enough to write back.
 *
 *  `bootstrap_app_state` is the ONLY read of `state.json` in the app's
 *  lifetime. Until it delivers, every contributing store above holds its EMPTY
 *  default — and `AppState::apply_patch` REPLACES `workspaces`, `groups` and
 *  `organisations` wholesale rather than merging them, so persisting that
 *  payload deletes the user's entire project and org list. The quit flush
 *  below runs unconditionally, so one undelivered snapshot would cost them
 *  everything on the way out, through no action of their own.
 *
 *  Hence DEFAULT-DENY: writes are off until the boot path has actually
 *  hydrated from a snapshot. Guarding the rejection alone would have left the
 *  cases that never settle — a hung IPC, a deadlocked lock, a cancelled boot —
 *  writing empty state, because the "it failed" branch never runs to suspend
 *  them. Starting closed covers every not-delivered path by construction.
 *
 *  Nothing re-reads `state.json` after boot, so once a session has come up
 *  without a snapshot the writes stay off for its lifetime; the boot path
 *  tells the user to restart, which is what recovers the on-disk data. */
let appStateWritable = false;

/** Flipped on by the boot path: `true` once a snapshot has hydrated the
 *  stores, `false` when it finally failed (and by tests). See
 *  `appStateWritable` for why this exists. */
export function setAppStateWritable(writable: boolean): void {
  appStateWritable = writable;
}

/** The single write point, so a future caller can't route around the guard. */
function persistAppState(label: string): Promise<void> {
  if (!appStateWritable) {
    console.warn(
      `${label} suppressed: no boot snapshot arrived, so the in-memory state is empty rather than the user's`,
    );
    return Promise.resolve();
  }
  return invoke<void>("save_app_state", { payload: buildAppStatePayload() }).catch((e) => {
    console.warn(`${label} failed:`, e);
  });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleAppStateSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistAppState("save_app_state");
  }, 500);
}

/** Flush the pending app-state save immediately (used by the switch/quit
 *  flush coordinator) so project list + active id are durable. */
export async function flushAppStateSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persistAppState("flushAppStateSave");
}

// The project list + active id must be durable on quit/close, so register it
// with the flush coordinator. On a SWITCH the write is fired without being
// awaited: it held a full IPC + disk round-trip on the critical path of every
// switch, for a payload that (a) is about to change again the moment the
// switch commits, and (b) is re-saved by the switch's own
// `scheduleAppStateSave()` 500ms later. Losing it in a crash costs project
// -list metadata only — never user content, which is what the awaited
// KB/editor flushes protect.
registerFlush("app-state", (ctx) => {
  if (ctx.reason === "switch") {
    void flushAppStateSave();
    return Promise.resolve();
  }
  return flushAppStateSave();
});

// Dedup gate: the persist hash last written to disk per project. If the
// project's snapshot hash is unchanged since the last write, we skip the
// editor-state disk write entirely (the user's "don't re-write the cache when
// the snapshot is identical").
const lastPersistedHash = new Map<string, string>();

// Editor tabs / split layout for a project. `ctx.path` is the OUTGOING
// project path (passed explicitly so the write targets the right project even
// after `currentProject` has swapped); falls back to the live current project
// for non-switch flushes (e.g. app quit).
registerFlush("editor-state", async (ctx) => {
  const path = ctx.path ?? useAppStore.getState().currentProject?.path;
  if (!path) return;

  // Skip the disk write when nothing the user cares about changed.
  if (ctx.projectId) {
    const hash = persistHashOf(ctx.projectId);
    if (hash && lastPersistedHash.get(ctx.projectId) === hash) {
      return; // identical snapshot — no write
    }
    if (hash) lastPersistedHash.set(ctx.projectId, hash);
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
 * Load every downstream store for `path` in parallel. Shared by project
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
  //
  // The stores load through `import()` on purpose: this file is in the BOOT
  // chunk (app hydration runs before first paint), and its static imports
  // dragged the git/knowledge/session/explorer stores — ~340KB of app code —
  // into that chunk. Nothing here runs before a project opens, so the chunks
  // can arrive when a project does. All of them are prefetched by the time a
  // human clicks anything; the split is for cold boot, not for these calls.
  void import("@/features/explorer/stores/explorer-store")
    .then((m) => m.useExplorerStore.getState().actions.openFolder(path))
    .catch((e) => console.error("Explorer failed:", e));
  void import("@/features/git/stores/git-store")
    .then((m) => m.useGitStore.getState().actions.loadStatus(path))
    .catch((e) => console.error("Git failed:", e));
  void import("./session-store")
    .then((m) => m.useSessionStore.getState().actions.loadSession(path))
    .catch((e) => console.error("Session load failed:", e));
  await Promise.all([
    import("@/features/knowledge/stores/knowledge-meta-store")
      .then((m) => m.useKnowledgeMetaStore.getState().actions.bind(path))
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
  // its setState from colliding with (and congesting) rapid project switches,
  // while still warming the @-/~ mention cache shortly after open. Fire-and-
  // forget; a stale project is harmless (entries are keyed by path).
  const warmEntries = () => {
    void import("@/features/knowledge/stores/knowledge-store")
      .then((m) => m.useKnowledgeStore.getState().actions.loadEntries(path))
      .catch((e) => console.error("Knowledge entries load failed:", e));
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warmEntries, { timeout: 2000 });
  } else {
    setTimeout(warmEntries, 0);
  }
}

export const useAppStore = createSelectors(
  create<AppState>()((set) => ({
    currentProject: null,
    recentProjects: [],
    hydrated: false,
    actions: {
      openProject: async (path: string) => {
        // The project store is now the single entry point for "open a
        // project": it dedupes by path (focus-existing) and drives the
        // flush/restore switch. Everything that used to call openProject
        // keeps working unchanged.
        await useProjectStore.getState().actions.addProject(path);
      },

      setActiveProject: (project: ProjectRef | null) => {
        if (!project) {
          set({ currentProject: null });
          return;
        }
        const { name, path } = project;
        // Tag the entry with the org it was opened under. Read lazily, like
        // `requireActiveOrgId` does, to avoid an import-time cycle with the
        // org store.
        const orgId =
          useOrgStore.getState().activeOrganisationId ??
          useOrgStore.getState().organisations[0]?.id ??
          null;
        set((s) => ({
          currentProject: { name, path },
          recentProjects: [
            { name, path, lastOpened: new Date().toISOString(), orgId },
            ...s.recentProjects.filter((r) => r.path !== path),
          ].slice(0, 20),
        }));

        // Idempotent + setting-gated. Safe to fire on every switch.
        maybeEnsureAtlasGitignore(path, useSettingsStore.getState().settings);
        // Grant the asset protocol access to this project's tree so the media
        // viewer can serve its files. Scope only widens across projects.
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
      hydrate: (payload: AppStateWire, opts?: { skipActiveSwitch?: boolean }) => {
        // Settings ride along in the bootstrap response but belong to the
        // settings feature — hand that slice over first so the theme/UI-scale
        // side effects land before anything renders.
        useSettingsStore.getState().actions.hydrate({
          settings: payload.settings,
          configGeneration: payload.configGeneration,
          configStatus: payload.configStatus,
        });

        set({
          currentProject: null,
          recentProjects: payload.recentProjects ?? [],
          hydrated: true,
        });

        // Hand the Organisation layer to the org store FIRST — the project
        // sidebar filters by the active org, and new projects tag themselves
        // with it. (Rust `migrate()` guarantees a default "Personal" org + an
        // `activeOrganisationId` on any pre-v3 state, so this is always set.)
        useOrgStore.getState().actions.hydrate({
          organisations: (payload.organisations ?? []).map(fromOrganisationWire),
          activeOrganisationId: payload.activeOrganisationId ?? null,
        });

        // Hand the multi-project fields to the project store. We hydrate
        // with `activeProjectId: null` and then `switchTo` the persisted id
        // below, so the switch is a genuine null→id transition that actually
        // runs the loaders (a same-id switch is a no-op by design).
        const projects = payload.workspaces ?? [];
        const groups = payload.groups ?? [];
        const activeProjectId = payload.activeWorkspaceId ?? null;
        useProjectStore.getState().actions.hydrate({
          projects,
          groups,
          activeProjectId: null,
        });

        // Restore the active project, if any. `switchTo` sets
        // `currentProject` (which drives the App-level Rust lifecycle effects)
        // and loads the downstream stores.
        //
        // `skipActiveSwitch` is set when a `atlas <path>` CLI launch is about to
        // open its own project: `switchTo` no-ops while another switch is in
        // flight (the `switching` guard), so auto-switching here would swallow
        // the CLI switch and strand the user on the persisted project. The
        // caller switches to the CLI project instead.
        //
        // Only a project of the active org: state saved before `closeProject`
        // was org-scoped can pair one org with another org's project, which
        // that org's switcher never shows.
        const orgId = useOrgStore.getState().activeOrganisationId;
        const active =
          activeProjectId &&
          projects.find((w) => w.id === activeProjectId && orgId != null && w.orgId === orgId);
        if (active && !opts?.skipActiveSwitch) {
          maybeEnsureAtlasGitignore(active.path, useSettingsStore.getState().settings);
          void useProjectStore.getState().actions.switchTo(active.id);
        }
      },
    },
  })),
);
