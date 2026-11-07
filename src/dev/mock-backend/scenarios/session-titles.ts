// Send a first message, then run `__atlasMock.actions.sendAgentTitle()`.
// Rename its sidebar row and run `sendLateTitleDelta()` to check that the
// header keeps the combined history title. Rust tests cover rejecting later
// agent titles; the late delta here deliberately exercises the UI's fallback.

import { emit } from "@tauri-apps/api/event";
import type { ThreadRow } from "@/features/chat/lib/history-api";
import { RESTING_LIFECYCLE } from "@/features/chat/lib/session-lifecycle";
import type { Entitlement } from "@/features/chat/stores/ai-grant-store";
import { sendTitle, setSessionSeeder, type NewSessionInfo } from "../fake-agent";
import { miscHandlers } from "../fixtures/misc";
import { MOCK_PROJECT } from "../project";
import type { Scenario } from "../types";

let live: NewSessionInfo | null = null;

async function sendAgentTitle(): Promise<void> {
  if (!live) return;
  const rows = miscHandlers.threads_history({}) as ThreadRow[];
  if (rows.some((row) => row.sessionId === live?.sessionId)) return;
  const title = "Parser error recovery";
  const now = new Date().toISOString();
  rows.unshift({
    threadId: `th-${live.sessionId}`,
    sessionId: live.sessionId,
    agentId: live.pluginId,
    title,
    updatedAt: now,
    createdAt: now,
    ...RESTING_LIFECYCLE,
    projectName: MOCK_PROJECT.name,
    folderPaths: [live.cwd],
    liveElsewhere: false,
    heldWorking: false,
    pullRequests: [],
    forkedFromSessionId: null,
    attachedProjects: [],
    model: null,
    branch: null,
  });
  await sendTitle(live.sessionId, title);
  await emit("atlas:threads-changed");
}

export const sessionTitles: Scenario = {
  name: "session-titles",
  description: "First-message titles, an agent title, and a permanent sidebar rename.",
  init: () => {
    live = null;
    setSessionSeeder((info) => {
      live ??= info;
      return null;
    });
  },
  rawCommands: {
    native_agent_entitlement: (): Entitlement => ({ state: "entitled", models: [] }),
  },
  actions: {
    sendAgentTitle,
    sendLateTitleDelta: async () => {
      if (live) await sendTitle(live.sessionId, "A later topic");
    },
  },
};
