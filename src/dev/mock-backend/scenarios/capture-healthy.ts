// The one capture state the default scenario cannot reach: a Project that is
// capturing with nothing wrong. The default seeds `acme-app` degraded, the
// experiments Project stopped and `docs` unbound (see `fixtures/capture.ts`),
// which covers every fault and leaves the healthy state unseen.
//
// Only the health answer changes, and only while capture is on: a paused
// Project still answers `off`, so Pause and Resume behave as in the default.

import type { CaptureHealth } from "@/features/capture/types";
import type { Scenario } from "../types";
import { captureHandlers } from "../fixtures/capture";
import { MOCK_PROJECT } from "../project";

export const captureHealthy: Scenario = {
  name: "capture-healthy",
  description: "acme-app capturing with no issues — the green, healthy state.",
  commands: {
    capture_health: async (args): Promise<CaptureHealth> => {
      const health = await captureHandlers.capture_health(args);
      if (args.projectPath !== MOCK_PROJECT.path || health.state === "off") return health;
      return {
        state: "ok",
        summary: "Capturing",
        issues: [],
        flaggedSessions: 0,
        failedRows: 0,
        pendingRows: 0,
      };
    },
  },
};
