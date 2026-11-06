import { invoke } from "@tauri-apps/api/core";

/** `cache` clears the app cache; `all` is a full reset to a first run.
 *  Mirrors `ResetScope` in `src-tauri/src/commands/app_data_reset.rs`. */
export type AppDataResetScope = "cache" | "all";

/** Schedules the wipe for the next launch and restarts Atlas into it. */
export function resetAppData(scope: AppDataResetScope): Promise<void> {
  return invoke("app_data_reset", { scope });
}
