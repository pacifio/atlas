import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import {
  getProjectSettings,
  updateProjectSettings,
  type ProjectSettingsInfo,
  type ProjectSettingsPatch,
} from "../lib/project-settings-api";
import type { AppSettings, SettingKey } from "../lib/app-settings";

/**
 * The overrides each project's `.atlas/config.toml` holds, by project path.
 * Loaded on first use and again whenever the window regains focus, so an
 * edit made by hand (or by an agent) shows up without a restart.
 *
 * The effective value of a key inside a project is `values[key]` when the
 * project sets it, else the global setting: {@link projectValue}.
 */
interface ProjectSettingsState {
  byPath: Record<string, ProjectSettingsInfo>;
  actions: {
    load: (projectPath: string) => Promise<void>;
    /** Set (a value) or clear (`null`) overrides in one project. */
    update: (projectPath: string, patch: ProjectSettingsPatch) => Promise<void>;
  };
}

const inFlight = new Map<string, Promise<void>>();

export const useProjectSettingsStore = createSelectors(
  create<ProjectSettingsState>()(
    immer((set) => ({
      byPath: {},
      actions: {
        load: (projectPath) => {
          const pending = inFlight.get(projectPath);
          if (pending) return pending;
          const request = getProjectSettings(projectPath)
            .then((info) => {
              // An unmocked command resolves null in the browser dev backend.
              if (!info) return;
              set((s) => {
                s.byPath[projectPath] = info;
              });
            })
            .catch(() => {})
            .finally(() => inFlight.delete(projectPath));
          inFlight.set(projectPath, request);
          return request;
        },
        update: async (projectPath, patch) => {
          try {
            const info = await updateProjectSettings(projectPath, patch);
            if (!info) return;
            set((s) => {
              s.byPath[projectPath] = info;
            });
          } catch (e) {
            toast.error(`Couldn't save project settings: ${e instanceof Error ? e.message : e}`);
          }
        },
      },
    })),
  ),
);

/** The value of `key` inside `projectPath`: its override, else `global`. */
export function projectValue<K extends SettingKey>(
  byPath: Record<string, ProjectSettingsInfo>,
  projectPath: string | null | undefined,
  key: K,
  global: AppSettings,
): AppSettings[K] {
  const values = projectPath ? byPath[projectPath]?.values : undefined;
  return values && key in values ? (values[key] as AppSettings[K]) : global[key];
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    const { byPath, actions } = useProjectSettingsStore.getState();
    for (const path of Object.keys(byPath)) void actions.load(path);
  });
}
