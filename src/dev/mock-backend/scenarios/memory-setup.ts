// Memory before its on-device embedding model is downloaded: the Graph tab
// opens on "Enable semantic memory" and Policy on "Enable preference
// learning". Pressing Download streams a fake progress bar and then unlocks
// the populated views; `failNextDownload` ends the next one on the
// "Model download failed" retry screen instead.

import { emit } from "@tauri-apps/api/event";
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

/** Whether "I made this edit" has been confirmed in this page load. */
let historyAccepted = false;

/** The memory history was edited outside Atlas: the destination bar's health
 *  line says so and offers "I made this edit". Confirming it clears the
 *  warning, as the real command does after its next health pass. */
export const memoryHistoryEdited: Scenario = {
  name: "memory-history-edited",
  description: "Memory tab whose history was edited outside Atlas (the broken-chain health line).",
  init: () => {
    historyAccepted = false;
  },
  commands: {
    memory_health_status: () => {
      const broken = historyAccepted ? [] : [{ kind: "chain_broken" as const }];
      return {
        checkedAt: Date.now(),
        record: { checkedAt: Date.now(), found: broken, repaired: [], deferred: broken },
        corpus: { rebuiltVectors: 0, rebuiltFts: false, recreated: false },
        restored: null,
      };
    },
    memory_accept_history: ({ projectPath }) => {
      historyAccepted = true;
      void emit("atlas:memory-health", { cwd: String(projectPath) });
      return true;
    },
  },
  setup: memorySetup.setup,
};
