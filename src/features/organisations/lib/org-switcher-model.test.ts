import { describe, expect, it } from "vitest";
import type { Organisation } from "../types";
import {
  canSubmitCreate,
  filterOrgs,
  finalHandle,
  orgAccess,
  orgInitials,
  toHandle,
} from "./org-switcher-model";

const local: Organisation = { id: "l1", name: "Side Project", slug: "side", syncEnabled: false };
const synced: Organisation = {
  id: "s1",
  name: "Acme",
  slug: "acme-inc",
  syncEnabled: true,
  remoteId: "srv-acme",
};

describe("orgAccess", () => {
  it("always opens a local org", () => {
    expect(orgAccess(local, { signedIn: false, memberOrgIds: null })).toEqual({ ok: true });
  });

  it("locks a synced org when signed out", () => {
    expect(orgAccess(synced, { signedIn: false, memberOrgIds: null })).toEqual({
      ok: false,
      reason: "Sign in to open this synced organization",
    });
  });

  it("locks a synced org the account is known not to belong to", () => {
    expect(orgAccess(synced, { signedIn: true, memberOrgIds: new Set(["other"]) })).toEqual({
      ok: false,
      reason: "This account isn't a member of this organization",
    });
  });

  it("opens a synced org the account belongs to", () => {
    expect(orgAccess(synced, { signedIn: true, memberOrgIds: new Set(["srv-acme"]) })).toEqual({
      ok: true,
    });
  });

  it("opens a synced org when membership is unknown", () => {
    expect(orgAccess(synced, { signedIn: true, memberOrgIds: null })).toEqual({ ok: true });
  });
});

describe("filterOrgs", () => {
  const orgs = [local, synced];
  it("keeps everything for a blank query", () => {
    expect(filterOrgs(orgs, "  ")).toBe(orgs);
  });
  it("matches the name case-insensitively", () => {
    expect(filterOrgs(orgs, "ACME")).toEqual([synced]);
  });
  it("matches the slug", () => {
    expect(filterOrgs(orgs, "inc")).toEqual([synced]);
  });
});

describe("orgInitials", () => {
  it.each([
    ["", "?"],
    ["acme", "AC"],
    ["Northwind Labs", "NL"],
  ])("%j → %s", (name, initials) => expect(orgInitials(name)).toBe(initials));
});

describe("handles", () => {
  it("lowercases, collapses separators and drops leading dashes", () => {
    expect(toHandle("  Acme  Inc--")).toBe("acme-inc-");
    expect(finalHandle("  Acme  Inc--")).toBe("acme-inc");
    expect(toHandle("--acme")).toBe("acme");
    expect(finalHandle("")).toBe("");
  });
});

describe("canSubmitCreate", () => {
  const ok = { submitting: false, name: "Acme", handle: "acme", slug: { kind: "idle" } } as const;
  it("allows a complete form", () => expect(canSubmitCreate(ok)).toBe(true));
  it.each([
    ["taken", { ...ok, slug: { kind: "taken" } as const }],
    ["checking", { ...ok, slug: { kind: "checking" } as const }],
    ["empty name", { ...ok, name: "  " }],
    ["empty handle", { ...ok, handle: "" }],
    ["submitting", { ...ok, submitting: true }],
  ])("refuses when %s", (_, form) => expect(canSubmitCreate(form)).toBe(false));
});
