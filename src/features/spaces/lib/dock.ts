/** Where the floating TOOL dock sits over the canvas. Persisted per app, not
 *  per Space — a pointing-hand preference, like a Figma toolbar position.
 *
 *  The pages panel is NOT affected by this: it is always the left sidebar. */
export type SpaceDock = "left" | "bottom" | "right";

// Renamed key: the setting used to move the pages panel, which is a different
// thing entirely — an old value would place the toolbar somewhere the user
// never asked for.
const KEY = "atlas:spaces:toolDock";

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
