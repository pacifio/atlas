// What team chat's home lists, and in what order, for a given search query.
//
// Pulled out of the home view so the filtering can be tested on its own and
// the view only renders. The rules are the home's, unchanged.

import { byRecency, conversationTitle } from "./derive";
import type { ChatConversation, OrgMemberProfile } from "../types";

export interface HomeSections {
  /** Channels you are in, most recent activity first. */
  channels: ChatConversation[];
  /** Group conversations, most recent first. */
  groupDms: ChatConversation[];
  /** One-to-one conversations, most recent first. */
  oneToOnes: ChatConversation[];
  /** Colleagues you have no 1:1 with yet, by name — the "you could talk to" tail. */
  contacts: OrgMemberProfile[];
  /** Channels you could join, most recent first. */
  discover: ChatConversation[];
}

export function homeSections({
  conversations,
  discoverable,
  members,
  me,
  query,
}: {
  conversations: readonly ChatConversation[];
  discoverable: readonly ChatConversation[];
  /** The roster, keyed by id. */
  members: Map<string, OrgMemberProfile>;
  me: string;
  query: string;
}): HomeSections {
  const q = query.trim().toLowerCase();
  const matches = (text: string | null | undefined) => !q || (text ?? "").toLowerCase().includes(q);

  const channels = conversations
    .filter((c) => c.kind === "channel" && matches(c.name))
    .sort(byRecency);

  // A conversation is found by the title the row shows, a group by its names.
  const directs = conversations
    .filter((c) => c.kind !== "channel" && matches(conversationTitle(c, members, me)))
    .sort(byRecency);
  // Group conversations and 1:1s are different things wearing the same row —
  // a group has a member count where a person has an address — so they are
  // two runs, with a rule between them, rather than one blended list.
  const groupDms = directs.filter((c) => c.kind === "group_dm");
  const oneToOnes = directs.filter((c) => c.kind !== "group_dm");

  // Who you already have a 1:1 with, whatever the query: a match on the
  // conversation's title must not put that person back among the contacts.
  const haveDm = new Set(
    conversations
      .filter((c) => c.kind === "dm")
      .flatMap((c) => (c.member_ids ?? []).filter((id) => id !== me)),
  );
  const contacts = [...members.values()]
    .filter((m) => m.id !== me && !haveDm.has(m.id))
    .filter((m) => matches(m.name) || matches(m.email))
    .sort((a, b) => a.name.localeCompare(b.name));

  const discover = discoverable.filter((c) => matches(c.name)).sort(byRecency);

  return { channels, groupDms, oneToOnes, contacts, discover };
}
