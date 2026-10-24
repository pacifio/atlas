import { describe, expect, it } from "vitest";

import { UNMEASURED, resolveOverviewDensity } from "./session-overview-layout";

describe("resolveOverviewDensity", () => {
  it("starts full before anything is measured", () => {
    expect(resolveOverviewDensity(100, UNMEASURED)).toBe("full");
  });

  it("stays full while the full card fits", () => {
    expect(resolveOverviewDensity(500, { full: 500, compact: 0 })).toBe("full");
  });

  it("steps down to compact once the full card is seen not to fit", () => {
    expect(resolveOverviewDensity(400, { full: 500, compact: 0 })).toBe("compact");
    expect(resolveOverviewDensity(400, { full: 500, compact: 380 })).toBe("compact");
  });

  it("steps down to essential when compact does not fit either", () => {
    expect(resolveOverviewDensity(300, { full: 500, compact: 380 })).toBe("essential");
  });

  it("climbs back once the height returns", () => {
    expect(resolveOverviewDensity(600, { full: 500, compact: 380 })).toBe("full");
  });
});
