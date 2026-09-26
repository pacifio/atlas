import { describe, expect, it } from "vitest";
import { orgAnswerOf, orgFailureOf, orgToolOf, orgToolRow, orgRowSubject } from "./org-tool-rows";

/** The text an organisation tool answers with, as the model reads it. */
const text = (value: unknown) => JSON.stringify(value);

/** The same answer as the native seam puts it on a chat tool call: the whole
 *  MCP result, pretty-printed, with the tool's text inside `content`. */
const mcpResult = (value: unknown) =>
  JSON.stringify(
    { content: [{ type: "text", text: text(value) }], structuredContent: null, _meta: null },
    null,
    2,
  );

describe("which calls are organisation calls", () => {
  it("recognises the organisation server's tools however the agent names them", () => {
    expect(orgToolOf("atlas_org.org_whoami")).toBe("org_whoami");
    expect(orgToolOf("mcp__atlas_org__org_members")).toBe("org_members");
  });

  it("leaves every other server's tools alone", () => {
    expect(orgToolOf("atlas_ui.ui_focus")).toBeNull();
    expect(orgToolOf("atlas_memory.memory_search")).toBeNull();
    expect(orgToolOf("write_file")).toBeNull();
    expect(orgToolOf("other.org_whoami")).toBeNull();
    expect(orgToolOf("org_whoami")).toBeNull();
  });
});

describe("reading an organisation answer", () => {
  it("reads the tool's JSON out of a chat tool call's MCP result", () => {
    expect(orgAnswerOf(mcpResult({ member: { name: "Grace" } }))).toEqual({
      member: { name: "Grace" },
    });
  });

  it("reads the tool's JSON as the audit record carries it", () => {
    expect(orgAnswerOf(text({ members: [] }))).toEqual({ members: [] });
  });

  it("has no answer for nothing, or for text that is not JSON", () => {
    expect(orgAnswerOf(null)).toBeNull();
    expect(orgAnswerOf("no member matches")).toBeNull();
  });

  it("says why a call failed, in the words the model was told", () => {
    expect(orgFailureOf("Atlas Agent's organisation access is switched off")).toBe(
      "Atlas Agent's organisation access is switched off",
    );
    expect(
      orgFailureOf(
        text({ error: '"Sam Lee" matches 2 members; ask the user which one', candidates: [] }),
      ),
    ).toBe('"Sam Lee" matches 2 members; ask the user which one');
    const refused = JSON.stringify({ content: [{ type: "text", text: "not found" }] });
    expect(orgFailureOf(refused)).toBe("not found");
  });
});

describe("the one-line subject of each organisation call", () => {
  const subject = (tool: string, args: Record<string, unknown>, answer: unknown) =>
    orgRowSubject(orgToolRow(tool, args, answer === undefined ? null : text(answer)));

  it("org_whoami names the organisation once it has answered", () => {
    expect(subject("org_whoami", {}, { organisation: { id: "org-acme", name: "Acme" } })).toBe(
      "Who am I in Acme",
    );
    expect(subject("org_whoami", {}, undefined)).toBe("Who am I");
    expect(subject("org_whoami", {}, { organisation: { id: "org-acme", name: null } })).toBe(
      "Who am I",
    );
  });

  it("org_members is the roster, or the member looked up", () => {
    expect(subject("org_members", {}, { members: [] })).toBe("Listed members");
    expect(subject("org_members", { name: "grace@acme.dev" }, undefined)).toBe(
      "Looked up grace@acme.dev",
    );
    expect(
      subject("org_members", { name: "grace@acme.dev" }, { member: { name: "Grace Hopper" } }),
    ).toBe("Looked up Grace Hopper");
  });

  it("org_conversations is the list, or the conversation looked up", () => {
    expect(subject("org_conversations", {}, { conversations: [] })).toBe("Listed conversations");
    expect(subject("org_conversations", { name: "#General" }, undefined)).toBe(
      "Looked up #General",
    );
    expect(
      subject("org_conversations", { name: "#General" }, { conversation: { name: "general" } }),
    ).toBe("Looked up #general");
  });

  it("a DM looked up is named by who is in it", () => {
    expect(
      subject(
        "org_conversations",
        { name: "c-dm" },
        {
          conversation: {
            kind: "dm",
            name: null,
            members: [
              { user_id: "u-1", name: "Ada" },
              { user_id: "u-2", name: "Grace" },
            ],
          },
        },
      ),
    ).toBe("Looked up DM with Ada, Grace");
  });

  it("org_inbox says the inbox was read, and how much of it is unread once answered", () => {
    expect(subject("org_inbox", {}, undefined)).toBe("Read inbox");
    expect(subject("org_inbox", {}, { unread: 3, entries: [], next_cursor: null })).toBe(
      "Read inbox: 3 unread",
    );
    expect(subject("org_inbox", { unread_only: true }, { unread: 0, entries: [] })).toBe(
      "Read unread inbox: 0 unread",
    );
  });

  it("org_comments names the recorded session it read", () => {
    expect(subject("org_comments", {}, undefined)).toBe("Read comments on this session");
    expect(subject("org_comments", { session: "current" }, undefined)).toBe(
      "Read comments on this session",
    );
    expect(subject("org_comments", { session: "rs-2" }, undefined)).toBe("Read comments on rs-2");
    expect(
      subject(
        "org_comments",
        { unresolved_only: true },
        { session: { id: "rs-1", title: "Fix the theme importer", current: true }, threads: [] },
      ),
    ).toBe("Read unresolved comments on Fix the theme importer");
    expect(
      subject("org_comments", { session: "rs-2" }, { session: { id: "rs-2", title: null } }),
    ).toBe("Read comments on rs-2");
  });

  it("org_comment_resolve says which way the thread went and which comment", () => {
    expect(subject("org_comment_resolve", { comment: "k1" }, undefined)).toBe(
      "Resolved comment k1",
    );
    expect(subject("org_comment_resolve", { comment: "k4", resolved: false }, undefined)).toBe(
      "Unresolved comment k4",
    );
    expect(
      subject("org_comment_resolve", { comment: "k1", resolved: true }, { comment: { id: "k1" } }),
    ).toBe("Resolved comment k1");
  });

  it("org_comment_reply names whose thread it answered, or the comment it was aimed at", () => {
    expect(
      subject(
        "org_comment_reply",
        { comment: "k2", body: "Done." },
        {
          thread: { id: "k1", author: { user_id: "u-sam1", name: "Sam Lee" } },
          comment: { id: "r6" },
        },
      ),
    ).toBe("Replied on Sam Lee's comment");
    expect(subject("org_comment_reply", { comment: "k2", body: "Done." }, undefined)).toBe(
      "Reply to k2",
    );
    expect(
      subject(
        "org_comment_reply",
        { comment: "k2" },
        { thread: { id: "k1", author: { name: null } } },
      ),
    ).toBe("Replied on comment k1");
  });

  it("org_send names the conversation it went into, or where it was aimed", () => {
    expect(
      subject(
        "org_send",
        { to: "general", body: "Deployed." },
        {
          conversation: { id: "c-general", kind: "channel", name: "general" },
          message_id: "m-1",
          client_msg_id: "cm-1",
          created_dm: false,
        },
      ),
    ).toBe("Sent to #general");
    expect(
      subject(
        "org_send",
        { to: "slee@acme.dev", body: "Welcome." },
        {
          conversation: { id: "c-dm-2", kind: "dm", name: null, members: [{ name: "Sam Lee" }] },
          message_id: null,
          client_msg_id: "cm-2",
          created_dm: true,
        },
      ),
    ).toBe("Sent to new DM with Sam Lee");
    expect(subject("org_send", { to: "Grace Hopper", body: "hi" }, undefined)).toBe(
      "Send to Grace Hopper",
    );
  });

  it("org_sessions says whose recorded sessions it listed and what it searched for", () => {
    expect(subject("org_sessions", {}, undefined)).toBe("Listed recorded sessions");
    expect(subject("org_sessions", { author: "me", limit: 1 }, undefined)).toBe(
      "Listed recorded sessions by you",
    );
    expect(subject("org_sessions", { author: "grace@acme.dev" }, undefined)).toBe(
      "Listed recorded sessions by grace@acme.dev",
    );
    expect(
      subject(
        "org_sessions",
        { author: "grace@acme.dev", q: "theme" },
        { author: { user_id: "u-grace", name: "Grace Hopper" }, sessions: [] },
      ),
    ).toBe('Searched recorded sessions by Grace Hopper for "theme"');
    expect(subject("org_sessions", { q: "importer" }, undefined)).toBe(
      'Searched recorded sessions for "importer"',
    );
  });

  it("org_session names the recorded session, or the entry, it read", () => {
    expect(subject("org_session", {}, undefined)).toBe("Read this session");
    expect(subject("org_session", { session: "rs-2" }, undefined)).toBe(
      "Read recorded session rs-2",
    );
    expect(
      subject(
        "org_session",
        {},
        { session: { id: "rs-1", title: "Fix the theme importer", current: true }, entries: [] },
      ),
    ).toBe("Read recorded session Fix the theme importer");
    expect(
      subject(
        "org_session",
        { entry: "e2", part: "result" },
        { session: { id: "rs-1", title: "Fix the theme importer" }, entry: { id: "e2" } },
      ),
    ).toBe("Read entry e2 of Fix the theme importer");
  });

  it("org_member_activity names whose recorded activity it read", () => {
    expect(
      subject(
        "org_member_activity",
        { member: "grace@acme.dev" },
        { member: { user_id: "u-grace", name: "Grace Hopper" }, totals: {} },
      ),
    ).toBe("Recorded activity of Grace Hopper");
    expect(subject("org_member_activity", { member: "grace@acme.dev" }, undefined)).toBe(
      "Recorded activity of grace@acme.dev",
    );
  });

  it("org_page_create names the page and the conversation whose Space holds it", () => {
    expect(
      subject(
        "org_page_create",
        { conversation: "#general", name: "Architecture" },
        {
          page_id: "p-1",
          conversation: { id: "c-general", kind: "channel", name: "general" },
          name: "Architecture",
        },
      ),
    ).toBe("Created page Architecture in #general");
    expect(
      subject(
        "org_page_create",
        { conversation: "c-dm-grace", name: "Plan" },
        {
          page_id: "p-2",
          conversation: {
            id: "c-dm-grace",
            kind: "dm",
            name: null,
            members: [{ name: "Grace Hopper" }],
          },
          name: "Plan",
        },
      ),
    ).toBe("Created page Plan in DM with Grace Hopper");
    // Asked, refused or failed: what was asked for, and where.
    expect(subject("org_page_create", { conversation: "design", name: "Plan" }, undefined)).toBe(
      "Create page Plan in design",
    );
  });

  it("org_page_write says how many nodes it drew on which page", () => {
    const args = { page: "p-1", conversation: "#general", document: { nodes: [], edges: [] } };
    expect(
      subject("org_page_write", args, {
        page_id: "p-1",
        name: "Architecture",
        nodes_placed: 7,
        edges_placed: 6,
      }),
    ).toBe("Drew 7 nodes on Architecture");
    expect(
      subject("org_page_write", args, { page_id: "p-1", nodes_placed: 1, edges_placed: 0 }),
    ).toBe("Drew 1 node on p-1");
    // Asked, refused or failed: the page asked for.
    expect(subject("org_page_write", args, undefined)).toBe("Draw on page p-1");
  });

  it("a tool with no line of its own still gets a row, named by the tool", () => {
    expect(subject("org_teleport", {}, undefined)).toBe("org_teleport");
  });
});
