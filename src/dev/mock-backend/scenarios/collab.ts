// Collaboration, all at once: `acme-app` is bound to Cloud in the same
// Organisation team chat is connected to (`org-mock`), in the Workspace its
// Timeline rows already carry (`rw_1d55e903`). That is the one binding under
// which the agent composer's `@` picker offers every organisation kind —
// members (the Acme roster), conversations (team chat's joined channels and
// DMs) and recorded Sessions (your own plus two teammates') — see
// `features/chat/lib/org-mentions.ts`. The default scenario keeps `acme-app`
// in local capture so the capture popover's local states stay reachable.

import type { Binding } from "@/features/capture/types";
import type { Scenario } from "../types";
import { captureHandlers } from "../fixtures/capture";
import { MOCK_ORG_ID, MOCK_PROJECT } from "../project";

export const collab: Scenario = {
  name: "collab",
  description:
    "acme-app synced to the team's Organization: @members, @conversations and @sessions in agent chat.",
  commands: {
    capture_binding: async (args): Promise<Binding | null> => {
      const binding = await captureHandlers.capture_binding(args);
      if (!binding || args.projectPath !== MOCK_PROJECT.path) return binding;
      return {
        ...binding,
        mode: "cloud",
        slug: "acme-app",
        orgId: MOCK_ORG_ID,
        remoteWorkspaceId: "rw_1d55e903",
        importApproved: true,
        drainState: "ok",
      };
    },
  },
};
