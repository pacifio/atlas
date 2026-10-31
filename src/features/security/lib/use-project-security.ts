import { useEffect } from "react";
import { useSecurityStore } from "../stores/security-store";
import { onSecurityScanChanged } from "./security-api";

const loaded = new Set<string>();
let watching = false;

/** Reload a Project's badges and open sessions whenever a scan is stored. */
function watch() {
  if (watching) return;
  watching = true;
  void onSecurityScanChanged((projectPath) => {
    if (loaded.has(projectPath))
      void useSecurityStore.getState().actions.refreshProject(projectPath);
  }).catch(() => {
    watching = false;
  });
}

/** Load a Project's session badges once, and keep them current. */
export function useProjectSecurity(projectPath: string): void {
  useEffect(() => {
    if (!projectPath) return;
    watch();
    if (loaded.has(projectPath)) return;
    loaded.add(projectPath);
    void useSecurityStore.getState().actions.loadProject(projectPath);
  }, [projectPath]);
}

/** Tests only: forget what was loaded. */
export function resetProjectSecurityForTests(): void {
  loaded.clear();
  watching = false;
}
