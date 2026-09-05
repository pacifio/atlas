/** Where the pages panel is docked. Persisted per app, not per Space — it is
 *  a workspace-layout preference, like the local canvas's pages toggle. */
export type SpaceDock = "left" | "bottom" | "right";

const KEY = "atlas:spaces:dock";

export function readDock(): SpaceDock {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "left" || v === "bottom" || v === "right") return v;
  } catch {
    /* private mode / storage disabled — the default is fine */
  }
  return "left";
}

export function writeDock(dock: SpaceDock): void {
  try {
    localStorage.setItem(KEY, dock);
  } catch {
    /* ignore */
  }
}
