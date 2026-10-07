// The heavy half of the mock backend: every fixture, every scenario, the
// badge. `install.ts` loads this with a dynamic `import()` once it has decided
// the mock is wanted, so the Tauri window (`bun run dev:app`) never fetches or
// evaluates any of it. See `install.ts` for load order.
//
// Answer order for each command:
//   1. the active scenario's `commands`   (`?scenario=<name>`)
//   2. `baseHandlers`                     (what the app needs to start)
//   3. fallback: resolves `null` and is listed as unmocked (console + badge)

import { emit } from "@tauri-apps/api/event";
import { baseHandlers } from "./scenarios/base";
import { scenarios } from "./scenarios";
import { mountBadge } from "./badge";
import { resetStores } from "./reset-stores";
import { mockAssetUrl } from "./fixtures/files";
import type { MockArgs, MockHandlers } from "./types";

declare global {
  interface Window {
    /** Console / Claude-in-Chrome handle on the mock backend. */
    __atlasMock?: {
      scenario: string;
      unmocked: () => string[];
      calls: () => { cmd: string; args: MockArgs | undefined }[];
      emit: typeof emit;
      actions: Record<string, () => void | Promise<void>>;
      /** Drop every Zustand store back to how it booted (decision 41). */
      resetStores: () => Promise<string[]>;
    };
  }
}

/**
 * `?record=1` (or `&record=1`): the page is being screen-recorded, so the mock
 * draws none of its own chrome. Read from the URL rather than the scenario,
 * because any scenario can be recorded.
 */
export function recordingMode(search: string = location.search): boolean {
  const value = new URLSearchParams(search).get("record");
  return value !== null && value !== "0" && value !== "false";
}

/** What `install.ts` needs back from a started backend. */
export interface MockBackend {
  /** Answer one `invoke(cmd, args)`. */
  answer: (cmd: string, args: unknown) => unknown;
  /** `convertFileSrc` for the seeded binary files; see `install.ts`. */
  assetUrl: typeof mockAssetUrl;
}

/**
 * Seed the scenario's state, mount the badge, publish `window.__atlasMock`,
 * and return the command dispatcher. Everything here that the app could
 * observe — fixture state, the `setup` hook — is reached only through an
 * answered `invoke()` or `atlas:app-ready`, both of which wait for this.
 */
export function startMockBackend(name: string): MockBackend {
  const scenario = scenarios[name];
  if (!scenario) {
    console.error(
      `[mock-backend] unknown scenario "${name}". Known: ${Object.keys(scenarios).join(", ")}`,
    );
  }
  // Indexed by any command name the frontend sends, so read through the
  // untyped view; each map is typed where it is written.
  const overrides: MockHandlers = { ...scenario?.rawCommands, ...scenario?.commands };

  const unmocked = new Map<string, number>();
  const calls: { cmd: string; args: MockArgs | undefined }[] = [];
  // `&record=1`: screen-recording mode — no badge, nothing on screen that the
  // real app would not draw. Unmocked commands still log to the console.
  const onUnmocked = recordingMode() ? () => {} : mountBadge(name, () => [...unmocked.keys()]);

  scenario?.init?.();

  const answer = (cmd: string, args: unknown): unknown => {
    const a = (args ?? {}) as MockArgs;
    if (calls.length < 2000) calls.push({ cmd, args: a });

    const handler = overrides[cmd] ?? baseHandlers[cmd];
    if (handler) return handler(a);

    if (!unmocked.has(cmd)) {
      console.warn(`[mock-backend] unmocked: ${cmd}`, a);
      onUnmocked();
    }
    unmocked.set(cmd, (unmocked.get(cmd) ?? 0) + 1);
    return null;
  };

  window.__atlasMock = {
    scenario: name,
    unmocked: () => [...unmocked.keys()].sort(),
    calls: () => calls,
    emit,
    actions: scenario?.actions ?? {},
    resetStores,
  };

  if (scenario?.setup) {
    const run = scenario.setup;
    window.addEventListener(
      "atlas:app-ready",
      () => {
        // Let the first commit settle so stores have hydrated before the
        // scenario opens tabs or fires events.
        setTimeout(() => void run(), 0);
      },
      { once: true },
    );
  }

  console.info(`[mock-backend] active — scenario "${name}"`);
  return { answer, assetUrl: mockAssetUrl };
}
