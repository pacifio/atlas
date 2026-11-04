/**
 * Who a Session belongs to, resolved once for the whole board.
 *
 * A board row carries an `authorId` and nothing else — the server stamps it
 * from the verified token and never sends a name, because the roster is a
 * different read with different permissions. Turning that id into a face and a
 * first name means a lookup, and doing it *inside* a row would put a store
 * subscription on all five hundred of them.
 *
 * So the lookup is built once, above the list, and passed down as one stable
 * object. Rows stay `memo`-able because the reference only changes when the
 * roster actually does.
 *
 * # Where the roster comes from
 *
 * `members-store`, keyed by the **server** org id — the same list the members
 * modal shows, and the only one that is populated whether or not team chat has
 * connected. Its `avatarPath` is a photo Rust already cached to disk, so a
 * board of five hundred rows costs no requests to Google or GitHub.
 */

import type { AccountUser, OrgMember } from "@/features/auth/lib/auth-api";
import {
  EMPTY_ORG_DIRECTORY,
  type OrgDirectory,
} from "@/features/organisations/lib/use-org-directory";

/**
 * The roster, as this feature names it.
 *
 * An alias rather than a second shape: `useOrgDirectory` owns fetching and the
 * lookup key, and two structurally identical types would eventually disagree
 * about which id they are keyed by — which is exactly how the comment thread
 * ended up reading the chat roster and rendering raw ids.
 */
export type AuthorDirectory = OrgDirectory;

export const EMPTY_DIRECTORY: AuthorDirectory = EMPTY_ORG_DIRECTORY;

export interface Author {
  /** What to print: a first name, or "You", or a legible stand-in. */
  label: string;
  /** The subject for `AccountAvatar`, or `null` when nobody matched — the
   *  caller draws no face rather than initials for a person it cannot name. */
  avatar: AccountUser | null;
  /** Is this the signed-in account's own work? */
  isSelf: boolean;
}

/**
 * First name only, and not shouting.
 *
 * The line has one row to spend on three things — a tick, a Project and a
 * person — and a full name eats the Project name to say something the face
 * already half-says. "AZRAF AL MONZIM" becomes "Azraf".
 *
 * ## Why the case is only corrected when it is *all* upper
 *
 * Plenty of people enter their name in caps, and rendered verbatim it shouts
 * across an otherwise quiet row. But blanket title-casing every name is worse:
 * it turns "McDonald" into "Mcdonald", "van Gogh" into "Van Gogh" and "danah"
 * into "Danah" — each of those is someone's name being corrected by a machine
 * that was not asked. A name with any lowercase in it is left exactly as its
 * owner typed it; only one with none at all is treated as shouting.
 */
export function firstName(full: string): string {
  const first = full.trim().split(/\s+/)[0] || full;
  const shouting = first === first.toUpperCase() && first !== first.toLowerCase();
  if (!shouting) return first;
  // `Array.from`, so a name opening outside the BMP is not split mid-codepoint.
  const [head, ...rest] = Array.from(first);
  return head === undefined ? first : head + rest.join("").toLowerCase();
}

/** `OrgMember` in the shape `AccountAvatar` reads. */
export function avatarOf(member: OrgMember): AccountUser {
  // `id` is the human, not the membership: the avatar's colour is derived from
  // it, and keying on the membership id would recolour the same person in
  // every Organisation they belong to.
  return {
    id: member.userId,
    name: member.name,
    email: member.email,
    avatarPath: member.avatarPath,
  } as AccountUser;
}

/**
 * Resolve a row's author.
 *
 * `authorId` is `null` on a Session captured on this machine: a local row is
 * this account's by construction, so there is nothing to look up and nothing
 * to be wrong about.
 */
export function authorOf(authorId: string | null, directory: AuthorDirectory): Author {
  const self =
    authorId === null || (directory.currentUserId !== null && authorId === directory.currentUserId);

  if (self) {
    // Their own face, when the roster has it. The label says "You" either way,
    // so a roster that has not loaded costs nothing here.
    const own = directory.currentUserId
      ? (directory.byId.get(directory.currentUserId) ?? null)
      : null;
    return { label: "You", avatar: own ? avatarOf(own) : null, isSelf: true };
  }

  const member = authorId === null ? null : (directory.byId.get(authorId) ?? null);
  return {
    // A colleague who has left the Organisation still owns their Sessions, and
    // an id is not a name. Say what is true instead of printing the raw key.
    label: member ? firstName(member.name) : "A member",
    avatar: member ? avatarOf(member) : null,
    isSelf: false,
  };
}
