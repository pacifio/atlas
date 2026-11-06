import { invoke } from "@tauri-apps/api/core";
import type { PlanRecord } from "./plans";

/** Every plan captured for a project, from its `.atlas/plans.json`. */
export function loadPlans(projectPath: string): Promise<PlanRecord[]> {
  return invoke<PlanRecord[]>("plans_load", { projectPath });
}
