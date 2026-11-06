// Memory before its on-device embedding model is downloaded: the Graph tab
// opens on "Enable semantic memory" and Policy on "Enable preference
// learning". Pressing Download streams a fake progress bar and then unlocks
// the populated views; `failNextDownload` ends the next one on the
// "Model download failed" retry screen instead.

import { emit } from "@tauri-apps/api/event";
import type { Scenario } from "../types";
import { S4, setMemoryModel } from "../fixtures/memory";

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

/** Projects whose "I made this edit" was confirmed in this page load. */
const acceptedProjects = new Set<string>();

/** The memory history was edited outside Atlas: the destination bar's health
 *  line says so and offers "I made this edit". Confirming it clears the
 *  warning, as the real command does after its next health pass. */
export const memoryHistoryEdited: Scenario = {
  name: "memory-history-edited",
  description: "Memory tab whose history was edited outside Atlas (the broken-chain health line).",
  init: () => {
    acceptedProjects.clear();
  },
  commands: {
    memory_health_status: ({ projectPath }) => {
      const broken = acceptedProjects.has(String(projectPath))
        ? []
        : [{ kind: "chain_broken" as const }];
      return {
        checkedAt: Date.now(),
        record: { checkedAt: Date.now(), found: broken, repaired: [], deferred: broken },
        corpus: { rebuiltVectors: 0, rebuiltFts: false, recreated: false },
        restored: null,
      };
    },
    memory_accept_history: ({ projectPath }) => {
      acceptedProjects.add(String(projectPath));
      void emit("atlas:memory-health", { cwd: String(projectPath) });
      return true;
    },
  },
  setup: memorySetup.setup,
};

/** The Memory tab, populated: the default story (twenty-odd memories from
 *  three agents and you, four sessions of activity, eight decisions waiting in
 *  Review: unconfirmed lines, a duplicate, a contradiction and two nightly
 *  proposals), opened on arrival. */
export const memoryPopulated: Scenario = {
  name: "memory",
  description: "Memory tab, populated: memories, activity and a review queue.",
  setup: memorySetup.setup,
};

/** The populated Memory tab, with the session that wrote the newest activity
 *  open in a background tab. Shows every way Memory asks the agent: the
 *  prompt line, a memory's "Ask agent…", the rows' hover ask, Review's
 *  "Ask agent…", and Activity's "Why did you learn this?" (aimed at that open
 *  session for its own lines, at a new session for the others). Errors and
 *  their "Fix with agent" are `memory-error`. */
export const memoryAskAgent: Scenario = {
  name: "memory-ask-agent",
  description: "Memory tab with every ask-agent entry point, and the newest session open.",
  setup: async () => {
    await memorySetup.setup?.();
    const { openAgentChatInNewTab } = await import("@/features/chat/lib/open-agent-session");
    const { useChatStore } = await import("@/features/chat/stores/chat-store");
    const tabId = openAgentChatInNewTab(undefined, { background: true });
    // As the session that wrote the newest activity, so its lines ask it.
    useChatStore.setState((s) => {
      const session = s.sessions[tabId];
      if (!session) return;
      session.acpSessionId = S4;
      session.title = "Why does the admin table refetch on focus?";
    });
  },
};

/** A project nothing has been remembered in yet: every tab's empty state. */
export const memoryEmpty: Scenario = {
  name: "memory-empty",
  description: "Memory tab for a project with no shared memory yet (the empty states).",
  commands: {
    memory_list_entries: () => [],
    memory_list_events: () => [],
    memory_review: () => ({ candidates: [], merges: [], conflicts: [], dreams: [] }),
  },
  setup: memorySetup.setup,
};

const LOCKED = "database is locked: memory.sqlite (another Atlas holds it)";

/** The record cannot be read: the tabs say so and offer a retry, instead of
 *  claiming the project remembers nothing. */
export const memoryError: Scenario = {
  name: "memory-error",
  description: "Memory tab whose shared-memory record fails to open (the error states).",
  commands: {
    memory_list_entries: () => {
      throw new Error(LOCKED);
    },
    memory_review: () => {
      throw new Error(LOCKED);
    },
  },
  setup: memorySetup.setup,
};

/** The record never answers: the loading ghosts, held still for review. */
export const memoryLoading: Scenario = {
  name: "memory-loading",
  description: "Memory tab while the record is still being read (the loading ghosts).",
  commands: {
    memory_list_entries: () => new Promise(() => {}),
  },
  setup: memorySetup.setup,
};
