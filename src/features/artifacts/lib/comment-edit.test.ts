import { describe, expect, it } from "vitest";

import type { OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { toEditable, toWireBody } from "./comment-edit";

const directory: OrgDirectory = {
  byId: new Map([
    ["u-ada", { userId: "u-ada", name: "Ada" } as OrgMember],
    ["u-ada-l", { userId: "u-ada-l", name: "Ada Lovelace" } as OrgMember],
    ["u-grace", { userId: "u-grace", name: "Grace Hopper" } as OrgMember],
  ]),
  currentUserId: "u-ada",
};

describe("toEditable", () => {
  it("shows mentions as names, and leaves an id nobody can name as its token", () => {
    expect(toEditable("ask <@u-grace> and <@u-gone>", directory)).toBe(
      "ask @Grace Hopper and <@u-gone>",
    );
  });
});

describe("toWireBody", () => {
  it("turns names back into tokens, longest name first", () => {
    expect(toWireBody("@Ada Lovelace and @Ada, cc @Grace Hopper", directory)).toBe(
      "<@u-ada-l> and <@u-ada>, cc <@u-grace>",
    );
  });

  it("leaves an @ that names nobody, an email, and an existing token alone", () => {
    expect(toWireBody("@Nobody mail ada@Ada.dev <@u-grace>", directory)).toBe(
      "@Nobody mail ada@Ada.dev <@u-grace>",
    );
  });

  it("round-trips a stored body unchanged", () => {
    const stored = "<@u-ada-l> please look — <@u-grace> agreed";
    expect(toWireBody(toEditable(stored, directory), directory)).toBe(stored);
  });
});

describe("a name two members share", () => {
  const twins: OrgDirectory = {
    byId: new Map([
      ["u-sam-1", { userId: "u-sam-1", name: "Sam" } as OrgMember],
      ["u-sam-2", { userId: "u-sam-2", name: "Sam" } as OrgMember],
    ]),
    currentUserId: null,
  };

  it("stays a token through an edit, so the mention keeps its person", () => {
    const stored = "cc <@u-sam-2>";
    expect(toEditable(stored, twins)).toBe(stored);
    expect(toWireBody(toEditable(stored, twins), twins)).toBe(stored);
  });

  it("is never guessed at when typed", () => {
    expect(toWireBody("cc @Sam", twins)).toBe("cc @Sam");
  });
});
