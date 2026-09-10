/**
 * Dev-only timing for tab switches.
 *
 * Two marks bracket a switch: `tabSwitchBegin` when the layout store's
 * `activeTabId` changes, `tabSwitchCommitted` when the content container has
 * committed the new active tab. The second mark then waits two animation
 * frames — the first fires before the switch frame paints, the second after
 * it — so the "paint" number covers whatever style, layout and paint work the
 * newly visible panel forced. That is the number a switch to a long chat
 * thread used to lose hundreds of milliseconds to (see the comment on the
 * chat wrapper in `center-panel.tsx`).
 *
 * Everything compiles to no-ops in production. In dev each switch prints one
 * line:
 *
 *   [tab-perf] chat 3120 rows: commit 4ms, paint 187ms
 *
 * and shows up as `tab:switch` in the Safari Web Inspector timeline. The last
 * few samples are readable from `window.__atlasTabPerf`.
 */

const DEV = import.meta.env.DEV;

export interface TabSwitchSample {
  tabId: string;
  type: string;
  rows: number;
  /** Store write → React commit of the new active tab. */
  commitMs: number;
  /** Store write → first frame painted with the new tab visible. */
  paintMs: number;
  at: number;
}

const MAX_SAMPLES = 20;
const samples: TabSwitchSample[] = [];
let pending: { tabId: string; t0: number } | null = null;

/** The active tab is about to change. Call from the store write. */
export function tabSwitchBegin(tabId: string): void {
  if (!DEV) return;
  pending = { tabId, t0: performance.now() };
  performance.mark("tab:switch:begin");
}

/**
 * The content container committed `tabId` as active. `rows` is evaluated
 * lazily so a DOM query for the row count only ever runs in dev.
 */
export function tabSwitchCommitted(tabId: string, type: string, rows: () => number): void {
  if (!DEV) return;
  const begin = pending;
  if (!begin || begin.tabId !== tabId) return;
  pending = null;
  const tCommit = performance.now();
  performance.mark("tab:switch:commit");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tPaint = performance.now();
      performance.measure("tab:switch", { start: begin.t0, end: tPaint });
      const sample: TabSwitchSample = {
        tabId,
        type,
        rows: rows(),
        commitMs: tCommit - begin.t0,
        paintMs: tPaint - begin.t0,
        at: begin.t0,
      };
      samples.push(sample);
      if (samples.length > MAX_SAMPLES) samples.shift();
      console.debug(
        `[tab-perf] ${type} ${sample.rows} rows: commit ${sample.commitMs.toFixed(1)}ms, paint ${sample.paintMs.toFixed(1)}ms`,
      );
    });
  });
}

if (DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__atlasTabPerf", { get: () => samples, configurable: true });
}
