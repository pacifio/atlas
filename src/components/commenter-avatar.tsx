/**
 * The face of whoever wrote a comment, everywhere inside a Session.
 *
 * One component rather than an `AccountAvatar` at each site, because a
 * commenter is not always a member: a shared Session's link can be opened by
 * someone with no account at all, and they can be allowed to comment on it.
 * Those guests have no face, and nothing in the roster to look one up in — so
 * they get generated art seeded by their author id, which is distinct per
 * guest and stable forever. Two guests on one thread are told apart at a
 * glance; the same guest is recognisable across their remarks.
 *
 * Before this, a guest's remark rendered with no avatar at all: a name and a
 * body floating where every other row had a face.
 *
 * In `src/components` because both the Timeline's comments and the live
 * chat's draw commenters. Its imports are TYPE-ONLY apart from the avatar:
 * the roster's own module subscribes to Tauri when it loads, and dragging
 * that into the chat's import graph broke tests that had no business knowing
 * about the Organisation store.
 */

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { GeneratedArt } from "@/components/generated-art";
import { cn } from "@/lib/utils";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

/** Who wrote it, as the comment wire describes them. */
export interface Commenter {
  authorId: string;
  /** Non-null means a guest, who must never be rendered as a member. */
  guestName: string | null;
}

/** The name to print beside the face. A guest's is their own, verbatim. */
export function commenterName(c: Commenter, directory: OrgDirectory | null): string {
  if (c.guestName) return c.guestName;
  const member = directory?.byId.get(c.authorId);
  if (member) return member.name || member.email;
  // Their own row, before the roster has loaded or when they are not in it.
  return directory?.currentUserId === c.authorId ? "You" : "A member";
}

export function CommenterAvatar({
  commenter,
  directory,
  size = 20,
  className,
}: {
  commenter: Commenter;
  directory: OrgDirectory | null;
  size?: number;
  className?: string;
}) {
  // `inline-flex`, not a bare span: width and height do not apply to a
  // non-replaced INLINE element, so inside any wrapper that is not itself a
  // flex container the art fell back to the SVG's natural size — a 14px pill
  // face drew as a 250px square.
  const shape = cn("inline-flex shrink-0 overflow-hidden rounded-full", className);

  if (commenter.guestName) {
    return (
      <span className={shape} style={{ width: size, height: size }}>
        <GeneratedArt seed={commenter.authorId} />
      </span>
    );
  }

  const member = directory?.byId.get(commenter.authorId);
  if (member) {
    return (
      <AccountAvatar
        user={{
          id: member.userId,
          name: member.name,
          email: member.email,
          avatarPath: member.avatarPath,
        }}
        size={size}
      />
    );
  }

  // A member the roster cannot name — someone who has left the Organisation.
  // Their art is still theirs, and it is better than an empty slot.
  return (
    <span className={shape} style={{ width: size, height: size }}>
      <GeneratedArt seed={commenter.authorId} />
    </span>
  );
}

/** The chip that says a commenter is not a member of the Organisation. */
export function GuestChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border border-border px-1.5 text-3xs font-medium",
        "uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      Guest
    </span>
  );
}
