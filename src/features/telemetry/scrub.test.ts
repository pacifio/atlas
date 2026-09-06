import { describe, expect, it } from "vitest";
import { scrubMessage } from "./posthog-client";

/**
 * TELEMETRY.md's rule is "never send user content". Command error strings
 * routinely interpolate exactly that — absolute home paths, repo names, raw
 * stderr — so everything captureClientError ships goes through this scrubber
 * first. These are the shapes the Sep-03 audit found leaving the machine.
 */
describe("scrubMessage", () => {
  it("collapses home directories, any user, any platform", () => {
    expect(scrubMessage("Failed to read /Users/adib/Desktop/atlas/src/x.ts: EACCES")).not.toContain(
      "adib",
    );
    expect(scrubMessage("no such file /home/kevin/work/repo/a.rs")).not.toContain("kevin");
  });

  it("reduces surviving path-likes to their extension", () => {
    const out = scrubMessage("could not parse /opt/thing/deep/nested/file.json here");
    expect(out).not.toContain("/opt/thing/deep/nested");
    expect(out).toContain("<path.json>");
  });

  it("masks token shapes, defense in depth", () => {
    for (const tok of ["ghp_" + "a".repeat(30), "sk-" + "b".repeat(30), "ey" + "J".repeat(40)]) {
      expect(scrubMessage(`auth failed: ${tok}`)).not.toContain(tok);
    }
  });

  it("caps length so stderr dumps cannot ride along", () => {
    expect(scrubMessage("x".repeat(5000)).length).toBeLessThanOrEqual(600);
  });

  it("leaves ordinary error text alone", () => {
    const msg = "WebSocket closed: code 1006 (abnormal closure)";
    expect(scrubMessage(msg)).toBe(msg);
  });
});
