import { describe, expect, it } from "vitest";

import { memberRowAccess } from "./member-access";

const plain = { isOwner: false };
const owner = { isOwner: true };

describe("memberRowAccess — your own row", () => {
  it("lets a plain member leave, with no role controls", () => {
    expect(
      memberRowAccess({ member: plain, isAdmin: false, isSelf: true, soleAdmin: false }),
    ).toEqual({ menu: true, roles: false, actionAllowed: true, blockedReason: null });
  });

  it("lets an admin leave while another admin remains", () => {
    const access = memberRowAccess({
      member: plain,
      isAdmin: true,
      isSelf: true,
      soleAdmin: false,
    });
    expect(access.actionAllowed).toBe(true);
    expect(access.roles).toBe(true);
  });

  it("refuses the last admin, and says why", () => {
    const access = memberRowAccess({ member: plain, isAdmin: true, isSelf: true, soleAdmin: true });
    expect(access.actionAllowed).toBe(false);
    expect(access.blockedReason).toMatch(/only admin/);
  });

  it("refuses the Owner whatever their role", () => {
    const admin = memberRowAccess({ member: owner, isAdmin: true, isSelf: true, soleAdmin: false });
    expect(admin.actionAllowed).toBe(false);
    expect(admin.blockedReason).toMatch(/owner can't leave/);
    // A demoted Owner has nothing to do from the menu, so it is not drawn.
    expect(
      memberRowAccess({ member: owner, isAdmin: false, isSelf: true, soleAdmin: false }).menu,
    ).toBe(false);
  });
});

describe("memberRowAccess — someone else's row", () => {
  it("shows a non-admin nothing", () => {
    expect(
      memberRowAccess({ member: plain, isAdmin: false, isSelf: false, soleAdmin: false }).menu,
    ).toBe(false);
  });

  it("lets an admin remove anyone but the Owner", () => {
    expect(
      memberRowAccess({ member: plain, isAdmin: true, isSelf: false, soleAdmin: true })
        .actionAllowed,
    ).toBe(true);
    const ownerRow = memberRowAccess({
      member: owner,
      isAdmin: true,
      isSelf: false,
      soleAdmin: false,
    });
    expect(ownerRow.actionAllowed).toBe(false);
    expect(ownerRow.blockedReason).toMatch(/can't be removed/);
  });
});
