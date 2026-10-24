import { describe, expect, it } from "vitest";

import { resolveLinkInput } from "./link-pull-request-input";

describe("resolveLinkInput", () => {
  it("reads a number with or without the hash", () => {
    expect(resolveLinkInput("42")).toEqual({ kind: "number", number: 42 });
    expect(resolveLinkInput("  #7 ")).toEqual({ kind: "number", number: 7 });
    expect(resolveLinkInput("#0").kind).toBe("error");
  });

  it("is empty for blank input", () => {
    expect(resolveLinkInput("   ")).toEqual({ kind: "empty" });
  });

  it("reads a URL from any repository as that repository's, whatever its tail", () => {
    expect(resolveLinkInput("https://github.com/acme/shop/pull/12")).toEqual({
      kind: "url",
      number: 12,
      repository: "acme/shop",
      url: "https://github.com/acme/shop/pull/12",
    });
    expect(resolveLinkInput("https://github.com/Acme/Docs/pull/12/files?diff=split")).toEqual({
      kind: "url",
      number: 12,
      repository: "Acme/Docs",
      url: "https://github.com/Acme/Docs/pull/12",
    });
    expect(resolveLinkInput("https://ghe.example.com/acme/shop/pulls/3")).toMatchObject({
      kind: "url",
      url: "https://ghe.example.com/acme/shop/pull/3",
    });
  });

  it("refuses an issue URL, a zero and a word", () => {
    expect(resolveLinkInput("https://github.com/acme/shop/issues/3").kind).toBe("error");
    expect(resolveLinkInput("https://github.com/acme/shop/pull/0").kind).toBe("error");
    expect(resolveLinkInput("discounts").kind).toBe("error");
  });
});
