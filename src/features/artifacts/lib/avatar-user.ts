import type { AccountUser, OrgMember } from "@/features/auth/lib/auth-api";

/**
 * `OrgMember` in the shape `AccountAvatar` reads.
 *
 * Keyed on `userId`, the human — the avatar's colour is derived from the id it
 * is given, and the membership id would recolour the same person per
 * Organisation.
 */
export function avatarUser(member: OrgMember): AccountUser {
  return {
    id: member.userId,
    name: member.name,
    email: member.email,
    avatarPath: member.avatarPath,
  } as AccountUser;
}
