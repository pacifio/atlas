// @vitest-environment happy-dom
//
// Composer mentions of the organisation (issue 122): a member, a conversation and
// a recorded session, searched in the organisation the chat's Project is bound
// to, inserted as chips, and sent as `atlas-org://` resource links carrying
// their ids. The recorded session is never the local past session.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

// The comms store holds one organisation's conversations at a time.
const comms = {
  connection: { state: "connected", reason: null, epoch: 1, orgId: "org-acme" as string | null },
  me: "u-1",
  members: [
    { id: "u-1", name: "Ada Lovelace", email: "ada@acme.dev", role: "developer" },
    { id: "u-grace", name: "Grace Hopper", email: "grace@acme.dev", role: "member" },
  ],
  conversations: [
    conv("c-general", "channel", "general", null, 5),
    conv("c-dm-grace", "dm", null, ["u-1", "u-grace"], 9),
    conv("c-old", "channel", "old-news", null, 1, 123),
  ],
};
vi.mock("@/features/comms/stores/comms-store", () => ({
  useCommsStore: { getState: () => comms },
}));

function conv(
  id: string,
  kind: string,
  name: string | null,
  memberIds: string[] | null,
  seq: number,
  archivedAt: number | null = null,
) {
  return {
    id,
    kind,
    name,
    visibility: "public",
    workspace_ref_ids: [],
    created_by: "u-1",
    created_at: 0,
    archived_at: archivedAt,
    seq,
    member_ids: memberIds,
    last_activity_seq: seq,
  };
}

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { useMembersStore } from "@/features/organisations/stores/members-store";
import { getMentions, insertMention, mentionExtension } from "./cm-mention-extension";
import {
  MENTION_CATEGORIES,
  categoryForKind,
  composePrompt,
  searchMentions,
  toShortForm,
  type MentionData,
} from "./mentions";
import { resetOrgMentionSourcesForTests } from "./org-mentions";

const PROJECT = "/work/atlas";

/** A Project bound to Acme's `ws-atlas` Workspace and recording. */
const cloudBinding = {
  workspaceId: "p-local",
  root: PROJECT,
  mode: "cloud",
  slug: null,
  orgId: "org-acme",
  rootCommitSha: null,
  fingerprintIsShallow: false,
  gitUrl: null,
  enabled: true,
  importApproved: true,
  drainState: "ok",
  remoteWorkspaceId: "ws-atlas",
  createdAt: "2026-09-01T00:00:00Z",
};

function row(id: string, title: string | null, remoteProjectId: string | null) {
  return { id, title, remoteProjectId, projectPath: PROJECT, projectName: "atlas" };
}

let binding: typeof cloudBinding | null = cloudBinding;
let boardReads = 0;

function orgMember(userId: string, name: string, email: string) {
  return {
    id: `m-${userId}`,
    userId,
    name,
    email,
    role: null,
    createdAt: null,
    avatarPath: null,
  };
}

beforeEach(() => {
  resetOrgMentionSourcesForTests();
  binding = cloudBinding;
  boardReads = 0;
  comms.connection.orgId = "org-acme";
  useMembersStore.setState({
    byOrg: {
      "org-acme": {
        members: [
          orgMember("u-grace", "Grace Hopper", "grace@acme.dev"),
          orgMember("u-1", "Ada Lovelace", "ada@acme.dev"),
        ],
        invitations: [],
        loadedAt: Date.now(),
        loading: false,
        error: null,
      },
    },
  });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "capture_binding":
        return binding;
      case "artifacts_board":
        boardReads += 1;
        expect(args).toEqual({ projects: [PROJECT] });
        return {
          sessions: [
            row("rs-ada", "Wire the org tools", "ws-atlas"),
            row("rs-grace", "Fix the theme importer", "ws-atlas"),
            row("rs-untitled", null, "ws-atlas"),
            // Another Workspace's session, from the organisation-wide cache:
            // the tools could not read it in this chat's Workspace.
            row("rs-elsewhere", "Fix the other thing", "ws-other"),
          ],
          cloudPending: false,
          cloudFailed: null,
        };
      case "mention_search":
        return [];
      default:
        throw new Error(`unexpected invoke ${cmd}`);
    }
  });
});

const ctx = { projectPath: PROJECT };
const ids = (found: MentionData[]) => found.map((m) => `${m.kind}:${m.id}`);

describe("searching the organisation", () => {
  it("offers members from the roster of the Project's organisation, by name or email", async () => {
    expect(ids(await searchMentions("", "member", ctx))).toEqual(["member:u-1", "member:u-grace"]);
    const found = await searchMentions("grace@", "member", ctx);
    expect(found).toEqual([
      { kind: "member", id: "u-grace", displayName: "Grace Hopper", email: "grace@acme.dev" },
    ]);
  });

  it("offers joined conversations, DMs titled by who else is in them, archived ones left out", async () => {
    const found = await searchMentions("", "conversation", ctx);
    expect(found).toEqual([
      {
        kind: "conversation",
        id: "c-dm-grace",
        displayName: "Grace Hopper",
        conversationKind: "dm",
      },
      {
        kind: "conversation",
        id: "c-general",
        displayName: "general",
        conversationKind: "channel",
      },
    ]);
    expect(ids(await searchMentions("gen", "conversation", ctx))).toEqual([
      "conversation:c-general",
    ]);
  });

  it("offers no conversations while chat is connected to another organisation", async () => {
    comms.connection.orgId = "org-other";
    expect(await searchMentions("", "conversation", ctx)).toEqual([]);
  });

  it("offers recorded sessions from the board, in the Project's Workspace only", async () => {
    const found = await searchMentions("", "recorded_session", ctx);
    expect(ids(found)).toEqual([
      "recorded_session:rs-ada",
      "recorded_session:rs-grace",
      "recorded_session:rs-untitled",
    ]);
    expect(found[1]).toEqual({
      kind: "recorded_session",
      id: "rs-grace",
      displayName: "Fix the theme importer",
      sessionId: "rs-grace",
      workspaceId: "ws-atlas",
    });
    expect(found[2].displayName).toBe("Untitled session");
    expect(ids(await searchMentions("theme", "recorded_session", ctx))).toEqual([
      "recorded_session:rs-grace",
    ]);
    expect(boardReads).toBe(1);
  });

  it("strips a category alias before matching", async () => {
    expect(ids(await searchMentions("timeline theme", "recorded_session", ctx))).toEqual([
      "recorded_session:rs-grace",
    ]);
    expect(ids(await searchMentions("channel gen", "conversation", ctx))).toEqual([
      "conversation:c-general",
    ]);
  });

  it("blends all three kinds into the unscoped @ search, each under its own category", async () => {
    const found = await searchMentions("grace", null, ctx);
    expect(ids(found)).toEqual(["member:u-grace", "conversation:c-dm-grace"]);
    const found2 = await searchMentions("importer", null, ctx);
    expect(found2.map((m) => categoryForKind(m.kind).label)).toEqual(["Recorded Sessions"]);
    expect(categoryForKind("member").label).toBe("Members");
    expect(categoryForKind("conversation").label).toBe("Conversations");
  });

  it("offers none of the three for a Project that is not bound to the cloud", async () => {
    for (const unbound of [
      null,
      { ...cloudBinding, mode: "local" },
      { ...cloudBinding, enabled: false },
      { ...cloudBinding, orgId: null },
    ]) {
      resetOrgMentionSourcesForTests();
      binding = unbound as typeof cloudBinding | null;
      for (const scope of ["member", "conversation", "recorded_session"] as const) {
        expect(await searchMentions("", scope, ctx), `${scope} ${JSON.stringify(unbound)}`).toEqual(
          [],
        );
      }
    }
    expect(boardReads).toBe(0);
  });

  it("reads the members of the binding's organisation, not the window's", async () => {
    binding = { ...cloudBinding, orgId: "org-beta" };
    useMembersStore.setState((s) => ({
      byOrg: {
        ...s.byOrg,
        "org-beta": {
          members: [orgMember("u-b", "Bea Beta", "bea@beta.dev")],
          invitations: [],
          loadedAt: Date.now(),
          loading: false,
          error: null,
        },
      },
    }));
    expect(ids(await searchMentions("", "member", ctx))).toEqual(["member:u-b"]);
  });
});

describe("a recorded session is not a past session", () => {
  const recorded: MentionData = {
    kind: "recorded_session",
    id: "rs-1",
    displayName: "Fix the theme importer",
    sessionId: "rs-1",
    workspaceId: "ws-atlas",
  };
  const past: MentionData = {
    kind: "past_session",
    id: "rs-1",
    displayName: "Fix the theme importer",
    sessionId: "rs-1",
    sessionTitle: "Fix the theme importer",
    cwd: PROJECT,
  };

  it("has its own category, label and short form", () => {
    expect(categoryForKind("recorded_session").label).toBe("Recorded Sessions");
    expect(categoryForKind("past_session").label).toBe("Past Sessions");
    expect(toShortForm(recorded)).toBe('@recorded-session:"Fix the theme importer"');
    expect(toShortForm(past)).toBe('@session:"Fix the theme importer"');
    const aliases = (k: string) => MENTION_CATEGORIES.find((c) => c.kind === k)!.aliases;
    expect(aliases("recorded_session").some((a) => aliases("past_session").includes(a))).toBe(
      false,
    );
  });

  it("renders as a chip with a different icon", () => {
    const view = editor();
    insertMention(view, past, 0, 0);
    insertMention(view, recorded, view.state.doc.length, view.state.doc.length);
    const chips = [...view.dom.querySelectorAll<HTMLElement>(".atlas-mention-chip")];
    expect(chips.map((c) => c.dataset.mentionKind)).toEqual(["past_session", "recorded_session"]);
    const icon = (c: HTMLElement) => c.querySelector(".atlas-mention-chip__icon")!.innerHTML;
    expect(icon(chips[0])).not.toBe(icon(chips[1]));
    view.destroy();
  });
});

function editor(): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ extensions: [mentionExtension] }), parent });
}

describe("inserting an organisation mention", () => {
  it("writes its short form and keeps the mention for the send", () => {
    const view = editor();
    const grace: MentionData = {
      kind: "member",
      id: "u-grace",
      displayName: "Grace Hopper",
      email: "grace@acme.dev",
    };
    const general: MentionData = {
      kind: "conversation",
      id: "c-general",
      displayName: "general",
      conversationKind: "channel",
    };
    view.dispatch({ changes: { from: 0, insert: "send it to " } });
    insertMention(view, grace, view.state.doc.length, view.state.doc.length);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "in " } });
    insertMention(view, general, view.state.doc.length, view.state.doc.length);
    expect(view.state.doc.toString()).toBe(
      'send it to @member:"Grace Hopper" in @conversation:general ',
    );
    expect(getMentions(view)).toEqual([grace, general]);
    const kinds = [...view.dom.querySelectorAll<HTMLElement>(".atlas-mention-chip")].map(
      (c) => c.dataset.mentionKind,
    );
    expect(kinds).toEqual(["member", "conversation"]);
    view.destroy();
  });
});

describe("sending", () => {
  it("hands every organisation mention to compose_prompt with its ids, and passes its links on", async () => {
    const mentions: MentionData[] = [
      { kind: "member", id: "u-grace", displayName: "Grace Hopper", email: "grace@acme.dev" },
      {
        kind: "conversation",
        id: "c-general",
        displayName: "general",
        conversationKind: "channel",
      },
      {
        kind: "recorded_session",
        id: "rs-1",
        displayName: "Fix the theme importer",
        sessionId: "rs-1",
        workspaceId: "ws-atlas",
      },
    ];
    const links = [
      { uri: "atlas-org://member/u-grace", name: "@member:Grace Hopper" },
      { uri: "atlas-org://conversation/c-general", name: "@conversation:general" },
      {
        uri: "atlas-org://recorded-session/ws-atlas/rs-1",
        name: '@recorded-session:"Fix the theme importer"',
      },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "compose_prompt") throw new Error(`unexpected invoke ${cmd}`);
      return { prose: "send it", resourceLinks: links };
    });
    const composed = await composePrompt("send it", mentions);
    expect(invoke).toHaveBeenCalledWith("compose_prompt", { prose: "send it", mentions });
    expect(composed).toEqual({ prose: "send it", resourceLinks: links });
  });
});
