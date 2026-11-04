// The local Canvas tab opened on the seeded board (`fixtures/spaces.ts`):
// "Architecture" with notes, text, a diamond, an image and edges; "Scratch"
// empty; the "2026" folder. Every other surface keeps the default data.

import type { Scenario } from "../types";

export const canvas: Scenario = {
  name: "canvas",
  description: "Canvas tab on the seeded board (Architecture, Scratch, a 2026 folder).",
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
    const existing = tabs.find((t) => t.type === "canvas");
    if (existing) actions.setActiveTab(existing.id);
    else
      actions.addTab({
        id: "canvas",
        type: "canvas",
        title: "Spaces",
        closable: true,
        dirty: false,
        data: {},
      });
  },
};
