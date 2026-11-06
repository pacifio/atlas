import { describe, expect, it } from "vitest";

import { UNMEASURED, resolveDetailsDensity } from "./details-density";

describe("resolveDetailsDensity", () => {
  it("starts full before anything is measured", () => {
    expect(resolveDetailsDensity(100, UNMEASURED)).toBe("full");
  });

  it("stays full while the full card fits", () => {
    expect(resolveDetailsDensity(500, { full: 500, compact: 0 })).toBe("full");
  });

  it("steps down to compact once the full card is seen not to fit", () => {
    expect(resolveDetailsDensity(400, { full: 500, compact: 0 })).toBe("compact");
    expect(resolveDetailsDensity(400, { full: 500, compact: 380 })).toBe("compact");
  });

  it("steps down to essential when compact does not fit either", () => {
    expect(resolveDetailsDensity(300, { full: 500, compact: 380 })).toBe("essential");
  });

  it("climbs back once the height returns", () => {
    expect(resolveDetailsDensity(600, { full: 500, compact: 380 })).toBe("full");
  });
});
