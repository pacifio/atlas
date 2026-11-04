import { describe, expect, it } from "vitest";
import { formatPageDate, propertiesSummary } from "./page-properties-model";

describe("propertiesSummary", () => {
  const none = { status: null, owner: null, tags: [] as string[] };

  it("shows the placeholder when nothing is set", () => {
    expect(propertiesSummary(none)).toBe("Add status, owner, tags…");
  });

  it("shows each part on its own", () => {
    expect(propertiesSummary({ ...none, status: "RFC" })).toBe("RFC");
    expect(propertiesSummary({ ...none, owner: "priya" })).toBe("@priya");
    expect(propertiesSummary({ ...none, tags: ["auth"] })).toBe("#auth");
  });

  it("joins the parts and counts the extra tags", () => {
    expect(
      propertiesSummary({ status: "RFC", owner: "priya", tags: ["auth", "security", "passkeys"] }),
    ).toBe("RFC · @priya · #auth +2");
  });
});

describe("formatPageDate", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("drops the year in the current year", () => {
    expect(formatPageDate("2026-03-04T12:00:00Z", now)).toBe("Mar 4");
  });

  it("keeps the year for another year", () => {
    expect(formatPageDate("2025-11-20T12:00:00Z", now)).toBe("Nov 20, 2025");
  });

  it("gives null for nothing or nonsense", () => {
    expect(formatPageDate(null, now)).toBeNull();
    expect(formatPageDate("", now)).toBeNull();
    expect(formatPageDate("not a date", now)).toBeNull();
  });
});
