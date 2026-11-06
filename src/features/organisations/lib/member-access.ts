/**
 * What the viewer may do from one row of the members table.
 *
 * Mirrors the server's rules so the menu only offers what would work, and says
 * why when it would not. The server decides regardless:
 *
 * - **Leave** (your own row) is open to every member, whatever their role —
 *   except the **Owner**, who cannot leave the org they created
 *   (`owner_cannot_leave`), and the **last admin**, who would leave nobody able
 *   to invite, change roles or delete it.
 * - **Remove** (anyone else's row) is admin-only, and never the Owner.
 * - **Role changes** are admin-only.
 *
 * Before this, the menu only existed for admins and an admin could not leave,
 * so nobody could leave an organisation from the desktop at all.
 */

import type { OrgMember } from "@/features/auth/lib/auth-api";

export interface MemberRowAccess {
  /** Draw the ⋯ menu at all. */
  menu: boolean;
  /** Include the role section. */
  roles: boolean;
  /** The Leave (own row) / Remove (other row) item is enabled. */
  actionAllowed: boolean;
  /** Why that item is disabled, for its tooltip. */
  blockedReason: string | null;
}

export function memberRowAccess({
  member,
  isAdmin,
  isSelf,
  soleAdmin,
}: {
  member: Pick<OrgMember, "isOwner">;
  isAdmin: boolean;
  isSelf: boolean;
  /** The viewer is the org's only admin. */
  soleAdmin: boolean;
}): MemberRowAccess {
  if (isSelf) {
    const blockedReason = member.isOwner
      ? "The owner can't leave the organization they created."
      : soleAdmin
        ? "You're the only admin — give someone else the Admin role first."
        : null;
    // A non-admin Owner (demoted) has nothing they could do from this menu.
    return {
      menu: isAdmin || !member.isOwner,
      roles: isAdmin,
      actionAllowed: blockedReason === null,
      blockedReason,
    };
  }
  if (!isAdmin) {
    return { menu: false, roles: false, actionAllowed: false, blockedReason: null };
  }
  return member.isOwner
    ? {
        menu: true,
        roles: true,
        actionAllowed: false,
        blockedReason: "The organization's owner can't be removed.",
      }
    : { menu: true, roles: true, actionAllowed: true, blockedReason: null };
}
