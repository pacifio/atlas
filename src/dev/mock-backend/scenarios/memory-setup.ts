// Memory before its on-device embedding model is downloaded: the Graph tab
// opens on "Enable semantic memory" and Policy on "Enable preference
// learning". Pressing Download streams a fake progress bar and then unlocks
// the populated views; `failNextDownload` ends the next one on the
// "Model download failed" retry screen instead.

import type { Scenario } from "../types";
import { setMemoryModel } from "../fixtures/memory";

export const memorySetup: Scenario = {
  name: "memory-setup",
  description: "Memory tab with the embedding model not yet downloaded (the setup gates).",
  init: () => setMemoryModel({ ready: false, downloadFails: false }),
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
    const existing = tabs.find((t) => t.type === "memory");
    if (existing) actions.setActiveTab(existing.id);
    else
      actions.addTab({
        id: "memory",
        type: "memory",
        title: "Memory",
        closable: true,
        dirty: false,
        data: {},
      });
  },
  actions: {
    /** Make the next Download fail: `__atlasMock.actions.failNextDownload()`. */
    failNextDownload: () => setMemoryModel({ downloadFails: true }),
  },
};

/** The memory history was edited outside Atlas: the destination bar's health
 *  line says so and offers "I made this edit". */
export const memoryHistoryEdited: Scenario = {
  name: "memory-history-edited",
  description: "Memory tab whose history was edited outside Atlas (the broken-chain health line).",
  commands: {
    memory_health_status: () => ({
      checkedAt: Date.now(),
      record: {
        checkedAt: Date.now(),
        found: [{ kind: "chain_broken" }],
        repaired: [],
        deferred: [{ kind: "chain_broken" }],
      },
      corpus: { rebuiltVectors: 0, rebuiltFts: false, recreated: false },
      restored: null,
    }),
  },
  setup: memorySetup.setup,
};
