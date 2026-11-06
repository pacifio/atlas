import { describe, expect, it } from "vitest";
import { homeSections } from "./home-sections";
import type { ChatConversation, OrgMemberProfile } from "../types";

const ME = "u_me";

const member = (id: string, name: string, email = `${id}@acme.dev`): OrgMemberProfile => ({
  id,
  name,
  email,
  role: "member",
});

const roster = [
  member(ME, "Me Myself"),
  member("u_ada", "Ada Lovelace", "ada@engines.org"),
  member("u_grace", "Grace Hopper"),
  member("u_alan", "Alan Turing"),
  member("u_barb", "Barbara Liskov", "barbara@lab.io"),
];
const members = new Map(roster.map((m) => [m.id, m]));

const conv = (
  id: string,
  over: Partial<ChatConversation> & Pick<ChatConversation, "kind">,
): ChatConversation => ({
  id,
  name: null,
  visibility: "public_org",
  workspace_ref_ids: [],
  created_by: ME,
  created_at: 0,
  archived_at: null,
  seq: 0,
  member_ids: null,
  last_activity_seq: 0,
  ...over,
});

const general = conv("c_general", { kind: "channel", name: "general", last_activity_seq: 5 });
const design = conv("c_design", { kind: "channel", name: "design", last_activity_seq: 9 });
const dmAda = conv("d_ada", { kind: "dm", member_ids: [ME, "u_ada"], last_activity_seq: 3 });
const dmGrace = conv("d_grace", { kind: "dm", member_ids: [ME, "u_grace"], last_activity_seq: 7 });
const group = conv("g_1", {
  kind: "group_dm",
  member_ids: [ME, "u_alan", "u_barb"],
  last_activity_seq: 1,
});
const hiring = conv("c_hiring", { kind: "channel", name: "hiring", last_activity_seq: 2 });
const random = conv("c_random", { kind: "channel", name: "random", last_activity_seq: 4 });

const sections = (query: string) =>
  homeSections({
    conversations: [general, dmAda, group, design, dmGrace],
    discoverable: [hiring, random],
    members,
    me: ME,
    query,
  });

const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("homeSections", () => {
  it("returns everything for an empty query, conversations most recent first", () => {
    const s = sections("  ");
    expect(ids(s.channels)).toEqual(["c_design", "c_general"]);
    expect(ids(s.groupDms)).toEqual(["g_1"]);
    expect(ids(s.oneToOnes)).toEqual(["d_grace", "d_ada"]);
    expect(ids(s.discover)).toEqual(["c_random", "c_hiring"]);
  });

  it("lists as contacts everyone but me and those I already have a 1:1 with, by name", () => {
    // Alan and Barbara share only a group conversation with me: still contacts.
    expect(ids(sections("").contacts)).toEqual(["u_alan", "u_barb"]);
  });

  it("matches a query on names, case-insensitively, in every section", () => {
    const s = sections("GRA");
    expect(ids(s.channels)).toEqual([]);
    expect(ids(s.oneToOnes)).toEqual(["d_grace"]);
    expect(ids(s.contacts)).toEqual([]);

    expect(ids(sections("des").channels)).toEqual(["c_design"]);
    expect(ids(sections("hir").discover)).toEqual(["c_hiring"]);
    expect(ids(sections("turing").groupDms)).toEqual(["g_1"]);
    expect(ids(sections("turing").contacts)).toEqual(["u_alan"]);
  });

  it("matches a contact on email, and a conversation on its title only", () => {
    // Barbara's address shares nothing with her name.
    expect(ids(sections("lab.io").contacts)).toEqual(["u_barb"]);
    // Ada's address is not her conversation's title.
    expect(ids(sections("engines.org").oneToOnes)).toEqual([]);
  });
});
