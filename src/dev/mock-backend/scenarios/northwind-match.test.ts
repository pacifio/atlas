import { describe, expect, it } from "vitest";

import type { AgentKey } from "./northwind-content-types";
import { CONTENT } from "./northwind-content";
import { matchRun } from "./northwind-match";

/**
 * The Atlas Learn prompts are typed live on camera. The exact wording in
 * `cue-sheet.md` must play its run, and so must the ways it gets mistyped;
 * a prompt about something else must still get the fallback answer.
 */

const runFor = (prompt: string, agent: AgentKey = "atlas-agent") =>
  matchRun(CONTENT.runs, prompt, agent)?.id;

describe("matchRun", () => {
  it("plays every scripted prompt as written", () => {
    expect(runFor("add a discount code field to checkout", "claude-code")).toBe(
      "run-discount-field",
    );
    expect(runFor("What is Zuhayer working on?")).toBe("run-what-is-zuhayer");
    expect(
      runFor("Post my discount code session to #shop and ask Zuhayer to check the validation."),
    ).toBe("run-post-discount");
    expect(runFor("Open the live one and tell me what it's stuck on.")).toBe("run-open-live");
    expect(runFor("Find the open comments on my last session and answer them.")).toBe(
      "run-answer-comments",
    );
    expect(runFor("Write a short report on my last session and post it to #shop.")).toBe(
      "run-report-shop",
    );
    expect(runFor("Should this validate the code server-side? do this", "claude-code")).toBe(
      "run-fix-from-comment",
    );
    expect(runFor("add a README section on running the tests", "codex")).toBe("run-readme-tests");
    expect(runFor("what does the checkout module export?", "codex")).toBe("run-checkout-exports");
    expect(runFor("/remember the discount code rule", "claude-code")).toBe("run-remember");
    expect(runFor("Where should discount codes get normalized?", "claude-code")).toBe(
      "run-where-normalize",
    );
  });

  it("forgives case, punctuation, plurals, word order and one typo", () => {
    const discount = (p: string) => runFor(p, "claude-code");
    expect(discount("Add a discount-code field to the checkout page")).toBe("run-discount-field");
    expect(discount("add discount codes fields to checkout")).toBe("run-discount-field");
    expect(discount("add a dicount code field to checkout")).toBe("run-discount-field");
    expect(discount("add a field for the discount code")).toBe("run-discount-field");
    expect(runFor("what's zuhayer workign on")).toBe("run-what-is-zuhayer");
    expect(runFor("Whats Zuhyer working on right now?")).toBe("run-what-is-zuhayer");
    expect(runFor("what does the checkout module exports", "codex")).toBe("run-checkout-exports");
  });

  it("prefers the more specific run when two match", () => {
    expect(runFor("Do this: move discount pricing to the server.", "claude-code")).toBe(
      "run-pricing-to-server",
    );
  });

  it("keeps short words exact and leaves other prompts to the fallback", () => {
    expect(runFor("add a discount mode field to checkout", "claude-code")).toBeUndefined();
    expect(runFor("refactor the cart page")).toBeUndefined();
    expect(runFor("what is the weather like")).toBeUndefined();
  });
});
